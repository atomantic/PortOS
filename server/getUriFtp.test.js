import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { getUri } from 'get-uri';

// Exercises get-uri's actual basic-ftp consumer, including its legacy-server
// LIST fallback. The fixture binds only loopback and uses no production data.
const fixtures = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(async ({ servers, sockets }) => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  }));
});

const startFtp = async (mdtmResponse) => {
  const commands = [];
  const servers = [];
  const sockets = new Set();
  const sessions = [];
  fixtures.push({ servers, sockets });
  const track = socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {}); // A client may reset its completed control connection.
    return socket;
  };
  const server = createServer(control => {
    track(control);
    const closed = new Promise(resolve => control.once('close', resolve));
    sessions.push(closed);
    control.setEncoding('utf8');
    control.write('220 Synthetic FTP ready\r\n');
    let buffer = '';
    let dataConnection;
    let passiveServer;
    control.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        commands.push(line);
        const verb = line.split(' ')[0];
        if (verb === 'USER') control.write('331 Password required\r\n');
        else if (verb === 'PASS') control.write('230 Logged in\r\n');
        else if (verb === 'FEAT') control.write('211-Features\r\n UTF8\r\n MLST type*;size*;modify*;\r\n211 End\r\n');
        else if (verb === 'MDTM') control.write(`${mdtmResponse}\r\n`);
        else if (verb === 'EPSV') {
          passiveServer = createServer();
          servers.push(passiveServer);
          dataConnection = once(passiveServer, 'connection').then(([socket]) => track(socket));
          passiveServer.listen(0, '127.0.0.1', () => {
            control.write(`229 Entering Extended Passive Mode (|||${passiveServer.address().port}|)\r\n`);
          });
        } else if (verb === 'MLSD' || verb === 'LIST' || verb === 'RETR') {
          control.write('150 Opening data connection\r\n');
          const payload = verb !== 'RETR'
            ? 'type=file;size=19;modify=20200101000000; example.txt\r\n'
            : 'synthetic download\n';
          dataConnection.then(socket => {
            socket.end(payload, () => {
              control.write('226 Transfer complete\r\n');
              passiveServer.close();
            });
          }).catch(error => control.destroy(error));
        } else if (verb === 'QUIT') control.end('221 Goodbye\r\n');
        else control.write('200 Command accepted\r\n');
      }
    });
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    url: `ftp://example:fixture@127.0.0.1:${server.address().port}/example.txt`,
    commands,
    sessions
  };
};

const readStream = async stream => {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
};

describe('get-uri FTP compatibility with the security override (#9444)', () => {
  it.each([
    ['MDTM', '213 20200101000000', false],
    ['directory listing fallback', '502 MDTM unsupported', true]
  ])('downloads, reads metadata, caches, and closes connections via %s', async (_name, response, listing) => {
    const ftp = await startFtp(response);
    const stream = await getUri(ftp.url);
    expect(await readStream(stream)).toBe('synthetic download\n');
    expect(stream.lastModified.toISOString()).toBe('2020-01-01T00:00:00.000Z');
    await ftp.sessions[0];
    expect(ftp.commands.some(command => command.startsWith('MLSD'))).toBe(listing);
    expect(ftp.commands).toContain('RETR /example.txt');
    ftp.commands.length = 0;
    await expect(getUri(ftp.url, { cache: stream })).rejects.toMatchObject({ code: 'ENOTMODIFIED' });
    await ftp.sessions[1];
    expect(ftp.commands.some(command => command.startsWith('RETR'))).toBe(false);
  });

  it('reports missing files without listing or downloading and closes the connection', async () => {
    const ftp = await startFtp('550 File missing');
    await expect(getUri(ftp.url)).rejects.toMatchObject({ code: 'ENOTFOUND' });
    await ftp.sessions[0];
    expect(ftp.commands.some(command => /^(LIST|MLSD|RETR)/.test(command))).toBe(false);
  });
});
