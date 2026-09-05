import * as https from 'https';
import { ClientRequest, IncomingHttpHeaders, IncomingMessage } from 'http';
import { CollectionError } from './usage';

export type RequestFactory = (options: https.RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;

/** O prazo cobre DNS, conexão e corpo inteiro, mesmo com bytes chegando continuamente. */
export function requestJson(options: https.RequestOptions, {
  signal, timeoutMs = 10_000, request: createRequest = https.request, maxBytes = 1024 * 1024
}: { signal?: AbortSignal; timeoutMs?: number; request?: RequestFactory; maxBytes?: number } = {}): Promise<{
  statusCode: number; headers: IncomingHttpHeaders; body: unknown;
}> {
  return new Promise((resolve, reject) => {
    let request: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let settled = false;
    const cleanUp = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const fail = (error: CollectionError) => {
      if (settled) { return; }
      settled = true;
      cleanUp();
      reject(error);
      response?.destroy();
      request?.destroy();
    };
    const abort = () => fail(new CollectionError('A consulta foi cancelada por exceder o prazo de atualização.', 'timeout'));
    const timer = setTimeout(() => fail(new CollectionError('Tempo esgotado ao consultar o serviço.', 'timeout')), timeoutMs);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    try {
      request = createRequest(options, incoming => {
        response = incoming;
        if (settled) { incoming.destroy(); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        incoming.on('error', () => fail(new CollectionError('A conexão foi interrompida durante a resposta.', 'network')));
        incoming.on('aborted', () => fail(new CollectionError('O serviço interrompeu a resposta antes de concluir.', 'network')));
        incoming.on('close', () => {
          if (!incoming.complete) { fail(new CollectionError('O serviço retornou uma resposta incompleta.', 'network')); }
        });
        incoming.on('data', chunk => {
          if (settled) { return; }
          size += chunk.length;
          if (size > maxBytes) { fail(new CollectionError('A resposta de cota excedeu o tamanho permitido.', 'invalid-response')); return; }
          chunks.push(Buffer.from(chunk));
        });
        incoming.on('end', () => {
          if (settled) { return; }
          if (!incoming.complete) { fail(new CollectionError('O serviço retornou uma resposta incompleta.', 'network')); return; }
          const statusCode = incoming.statusCode ?? 500;
          let body: unknown;
          if (statusCode >= 200 && statusCode < 300) {
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
            catch { fail(new CollectionError('O serviço retornou uma resposta de cota inválida.', 'invalid-response')); return; }
          }
          settled = true;
          cleanUp();
          resolve({ statusCode, headers: incoming.headers, body });
        });
      });
      request.on('error', () => fail(new CollectionError('Não foi possível conectar ao serviço de cotas.', 'network')));
      request.end();
    } catch { fail(new CollectionError('Não foi possível iniciar a consulta de cotas.', 'network')); }
  });
}
