import * as https from 'https';
import * as tls from 'tls';
import { ClientRequest, IncomingHttpHeaders, IncomingMessage } from 'http';
import { CollectionError, safeFailureCode } from './usage';

export type RequestFactory = (options: https.RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;

/** Falhas em que o emissor do certificado não é reconhecido pelas raízes embutidas no Node. */
const UNTRUSTED_ISSUER = new Set(['SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_UNTRUSTED']);

/**
 * Raízes embutidas no Node somadas às da loja de certificados do Windows. Antivírus e proxies
 * que inspecionam HTTPS reassinam a conexão com uma raiz instalada só na loja do sistema.
 */
export function windowsTrustedRoots(): string[] | undefined {
  try {
    const read = (tls as unknown as { getCACertificates?: (type: string) => string[] }).getCACertificates;
    const system = typeof read === 'function' ? read('system') : [];
    return system.length ? [...tls.rootCertificates, ...system] : undefined;
  } catch { return undefined; }
}

/**
 * O prazo cobre DNS, conexão e corpo inteiro, mesmo com bytes chegando continuamente.
 * A validação começa só com as raízes do Node; se o emissor não for reconhecido, a consulta
 * é refeita uma vez aceitando também as raízes do Windows (`systemTrust: true` na resposta).
 * Nada é enviado na tentativa recusada: o handshake falha antes dos headers.
 */
export function requestJson(options: https.RequestOptions, {
  signal, timeoutMs = 10_000, request: createRequest = https.request, maxBytes = 1024 * 1024, systemRoots = windowsTrustedRoots
}: { signal?: AbortSignal; timeoutMs?: number; request?: RequestFactory; maxBytes?: number; systemRoots?: () => string[] | undefined } = {}): Promise<{
  statusCode: number; headers: IncomingHttpHeaders; body: unknown; systemTrust: boolean;
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

    const start = (roots?: string[]) => {
      try {
        const current = createRequest(roots ? { ...options, ca: roots } : options, incoming => {
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
            resolve({ statusCode, headers: incoming.headers, body, systemTrust: !!roots });
          });
        });
        request = current;
        current.on('error', (error: NodeJS.ErrnoException) => {
          if (settled || request !== current) { return; }
          const code = safeFailureCode(error?.code);
          if (code && UNTRUSTED_ISSUER.has(code)) {
            const fallback = roots ? undefined : systemRoots();
            if (fallback) { start(fallback); return; }
            fail(new CollectionError('Um antivírus ou proxy interceptou a conexão segura com um certificado que o Windows não reconhece.', 'tls', code));
            return;
          }
          fail(new CollectionError('Não foi possível conectar ao serviço de cotas.', 'network', code));
        });
        current.end();
      } catch { fail(new CollectionError('Não foi possível iniciar a consulta de cotas.', 'network')); }
    };
    start();
  });
}
