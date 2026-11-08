import * as assert from 'assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodexCollector } from '../collectors/codex';

// Fixture do shim gerado pelo npm, incluindo o comando title que queremos evitar.
const npmShim = String.raw`@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*`;

export async function runCodexWindowsTests(): Promise<number> {
  let passed = 0;
  const check = async (name: string, run: () => void | Promise<void>) => {
    await run(); passed++; console.log(`PASS: ${name}`);
  };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tokenbar-codex-test-'));
  const collector = new CodexCollector();
  const target = process.arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const write = (filename: string, contents = '') => {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents);
    return filename;
  };
  const install = (name: string, layout: 'nested' | 'hoisted' | 'legacy') => {
    const prefix = path.join(directory, name);
    const root = path.join(prefix, 'node_modules', '@openai', 'codex');
    const entry = write(path.join(root, 'bin', 'codex.js'), 'throw new Error("The launcher must not run");');
    write(path.join(root, 'package.json'), JSON.stringify({ name: '@openai/codex', bin: { codex: 'bin/codex.js' } }));
    let vendor = path.join(root, 'vendor');
    if (layout !== 'legacy') {
      const platformRoot = path.join(layout === 'nested' ? root : prefix, 'node_modules', '@openai', `codex-win32-${process.arch}`);
      write(path.join(platformRoot, 'package.json'), JSON.stringify({ name: `@openai/codex-win32-${process.arch}` }));
      vendor = path.join(platformRoot, 'vendor');
    }
    const binary = write(path.join(vendor, target, layout === 'legacy' ? 'codex' : 'bin', 'codex.exe'), 'synthetic executable; never run');
    const command = write(path.join(prefix, 'codex.cmd'), npmShim.replace(/\n/g, '\r\n'));
    return { prefix, root, entry, binary, command };
  };

  try {
    for (const layout of ['nested', 'hoisted', 'legacy'] as const) {
      await check(`Codex resolve binário nativo ${layout}, inclusive com espaços no caminho`, () => {
        const fixture = install(`npm with spaces ${layout}`, layout);
        assert.deepEqual(collector.resolveCodexTarget(fixture.entry), { executable: fixture.binary, args: [] });
        assert.deepEqual(collector.resolveCodexTarget(fixture.command), { executable: fixture.binary, args: [] });
      });
    }

    await check('Codex segue links de pacotes para localizar a dependência nativa correta', () => {
      const fixture = install('store', 'nested');
      const linkedRoot = path.join(directory, 'linked', 'node_modules', '@openai', 'codex');
      fs.mkdirSync(path.dirname(linkedRoot), { recursive: true });
      fs.symlinkSync(fixture.root, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
      assert.equal(collector.resolveCodexTarget(path.join(linkedRoot, 'bin', 'codex.js')).executable, fixture.binary);
    });

    await check('Codex não confunde JS personalizado, pacote incompleto ou diretório com binário oficial', () => {
      const fixture = install('unknown package', 'nested');
      write(path.join(fixture.root, 'package.json'), JSON.stringify({ name: 'custom-launcher' }));
      assert.deepEqual(collector.resolveCodexTarget(fixture.entry), { executable: process.execPath, args: [fixture.entry] });
      assert.deepEqual(collector.resolveCodexTarget(fixture.command), { executable: fixture.command, args: [] });
      write(path.join(fixture.root, 'package.json'), JSON.stringify({ name: '@openai/codex' }));
      fs.unlinkSync(fixture.binary);
      fs.mkdirSync(fixture.binary);
      assert.deepEqual(collector.resolveCodexTarget(fixture.command), { executable: fixture.command, args: [] });
    });

    await check('Codex preserva scripts com argumentos, ambiente, %~dp0 e caminhos relativos', () => {
      const fixture = install('custom wrappers', 'nested');
      for (const content of [
        npmShim.replace(' %*', ' --profile "custom profile" %*'),
        `set "CODEX_HOME=custom-home"\n${npmShim}`,
        '@echo off\nnode "%~dp0custom\\codex.js" --profile custom %*',
        '@echo off\nnode "custom\\codex.js" %*'
      ]) {
        write(fixture.command, content);
        assert.deepEqual(collector.resolveCodexTarget(fixture.command), { executable: fixture.command, args: [] });
      }
      const batch = write(path.join(fixture.prefix, 'codex.bat'), 'node "%~dp0custom.js" --profile custom %*');
      assert.deepEqual(collector.resolveCodexTarget(batch), { executable: batch, args: [] });
    });

    await check('Codex respeita o atalho npm personalizado e ignora diretórios no PATH', () => {
      const previousAppData = process.env.APPDATA;
      const previousPath = process.env.PATH;
      try {
        const appData = path.join(directory, 'appdata');
        const fixture = install(path.join('appdata', 'npm'), 'nested');
        process.env.APPDATA = appData;
        process.env.PATH = '';
        write(fixture.command, 'node "%~dp0custom.js" %*');
        assert.equal((collector as any).findCodexOnWindows(), fixture.command);
        process.env.APPDATA = path.join(directory, 'missing appdata');
        const bin = path.join(directory, 'custom bin');
        fs.mkdirSync(path.join(bin, 'codex.exe'), { recursive: true });
        const command = write(path.join(bin, 'codex.cmd'), npmShim);
        process.env.PATH = `"${bin}"`;
        assert.equal((collector as any).findCodexOnWindows(), command);
        process.env.PATH = '';
        assert.equal((collector as any).findCodexOnWindows(), undefined);
      } finally {
        if (previousAppData === undefined) { delete process.env.APPDATA; } else { process.env.APPDATA = previousAppData; }
        if (previousPath === undefined) { delete process.env.PATH; } else { process.env.PATH = previousPath; }
      }
    });

    if (process.platform === 'win32') {
      await check('Codex inicia só o binário final com windowsHide e mantém JS em modo Node', () => {
        const childProcess = require('child_process') as typeof import('child_process');
        const originalSpawn = childProcess.spawn;
        const calls: any[][] = [];
        const local = new CodexCollector() as any;
        const fixture = install('hidden spawn', 'nested');
        try {
          childProcess.spawn = ((...args: any[]) => { calls.push(args); return {}; }) as typeof childProcess.spawn;
          local.findCodexOnWindows = () => fixture.command;
          local.spawnCodex();
          assert.equal(calls.length, 1);
          assert.equal(calls[0][0], fixture.binary);
          assert.deepEqual(calls[0][1], ['app-server', '--stdio']);
          assert.equal(calls[0][2].windowsHide, true);
          assert.equal(calls[0][2].shell, undefined);
          const customJs = write(path.join(directory, 'custom.js'));
          local.findCodexOnWindows = () => customJs;
          local.spawnCodex();
          assert.equal(calls[1][0], process.execPath);
          assert.equal(calls[1][2].windowsHide, true);
          assert.equal(calls[1][2].env.ELECTRON_RUN_AS_NODE, '1');
        } finally { childProcess.spawn = originalSpawn; }
      });

      for (const extension of ['cmd', 'bat']) {
        await check(`Codex executa .${extension} personalizado sem perder argumentos, ambiente ou diretório`, async () => {
          const fixture = install(`custom space & symbol ${extension}`, 'nested');
          write(path.join(fixture.prefix, 'custom.js'), `console.log(JSON.stringify({ args: process.argv.slice(2), marker: process.env.TOKENBAR_TEST_MARKER, cwd: process.cwd() }));`);
          const command = write(path.join(fixture.prefix, `codex.${extension}`), [
            '@echo off', 'set "TOKENBAR_TEST_MARKER=preserved"', 'cd /d "%~dp0"',
            `"${process.execPath}" "%~dp0custom.js" --profile "synthetic profile" %*`
          ].join('\r\n'));
          const local = new CodexCollector() as any;
          local.findCodexOnWindows = () => command;
          const child = local.spawnCodex() as import('child_process').ChildProcessWithoutNullStreams;
          let output = ''; let stderr = '';
          child.stdout.on('data', chunk => { output += chunk; });
          child.stderr.on('data', chunk => { stderr += chunk; });
          child.stdin.end();
          const code = await new Promise<number | null>((resolve, reject) => {
            const timer = setTimeout(() => { child.kill(); reject(new Error('Synthetic wrapper timeout')); }, 5000);
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.once('close', code => { clearTimeout(timer); resolve(code); });
          });
          assert.equal(code, 0, stderr);
          const result = JSON.parse(output);
          assert.deepEqual(result.args, ['--profile', 'synthetic profile', 'app-server', '--stdio']);
          assert.equal(result.marker, 'preserved');
          assert.equal(result.cwd, fixture.prefix);
        });
      }

      // Achado 4: o wrapper morre no kill(), mas o app-server que ele iniciou não.
      // Os processos são todos da fixture; o descendente se encerra sozinho em 8 s,
      // e o teste só espera por ele, nunca encerra um PID por conta própria.
      const alive = (pid: number) => {
        try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
      };
      const waitFor = async <T>(probe: () => T | undefined, timeoutMs: number): Promise<T | undefined> => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const value = probe();
          if (value !== undefined || Date.now() > deadline) { return value; }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      };
      for (const mode of ['cancel', 'respond'] as const) {
        await check(`Codex encerra o app-server descendente de um wrapper .cmd (${mode === 'cancel' ? 'cancelamento' : 'resposta concluída'}, achado 4)`, async () => {
          const prefix = path.join(directory, `descendant ${mode}`);
          const pidFile = path.join(prefix, 'descendant.pid');
          const resetsAt = Math.floor(Date.now() / 1000) + 3600;
          write(path.join(prefix, 'server.js'), [
            `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
            'setTimeout(() => process.exit(0), 8000);',
            // Ignora o EOF do stdin, como um app-server travado.
            mode === 'respond' ? [
              'let buffer = "";',
              'process.stdin.on("data", chunk => {',
              '  buffer += chunk; const lines = buffer.split("\\n"); buffer = lines.pop();',
              '  for (const line of lines) { if (!line.trim()) continue; const message = JSON.parse(line);',
              '    if (message.id === 1) process.stdout.write(JSON.stringify({ id: 1, result: {} }) + "\\n");',
              `    if (message.id === 2) process.stdout.write(JSON.stringify({ id: 2, result: { rateLimits: { limitId: "codex", primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: ${resetsAt} } } } }) + "\\n"); }`,
              '});'
            ].join('\n') : 'process.stdin.resume();'
          ].join('\n'));
          const command = write(path.join(prefix, 'codex.cmd'), ['@echo off', `"${process.execPath}" "%~dp0server.js" %*`].join('\r\n'));
          const local = new CodexCollector() as any;
          local.findCodexOnWindows = () => command;
          const controller = new AbortController();
          let pid: number | undefined;
          try {
            const pending = local.collect(false, controller.signal) as Promise<import('../usage').ProviderSnapshot>;
            pid = await waitFor(() => fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) || undefined : undefined, 10_000);
            assert.ok(pid, 'o descendente da fixture não iniciou');
            if (mode === 'cancel') { controller.abort(); }
            const result = await pending;
            if (mode === 'cancel') {
              assert.equal(result.failureKind, 'timeout');
            } else {
              assert.equal(result.status, 'ok', result.message);
              assert.equal(result.windows[0].usedPercent, 12);
            }
            const stopped = await waitFor(() => alive(pid!) ? undefined : true, 3_000);
            assert.equal(stopped, true, `o descendente ${pid} continuou ativo depois da coleta`);
          } finally {
            if (pid) { await waitFor(() => alive(pid!) ? undefined : true, 10_000); }
          }
        });
      }
    }
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('tokenbar-codex-test-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
  return passed;
}
