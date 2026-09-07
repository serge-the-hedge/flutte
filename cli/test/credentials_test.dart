import 'dart:io';

import 'package:blabla_cli/credentials.dart';
import 'package:blabla_cli/locale_proposal_adapter.dart';
import 'package:test/test.dart';

void main() {
  test('secret bytes are private before chmod and final rename', () async {
    final home = await Directory.systemTemp.createTemp('blabla-credentials-');
    addTearDown(() => home.delete(recursive: true));
    final wrapper = File('${home.path}/bin/chmod');
    await wrapper.parent.create();
    // Refuse the permission change if secret bytes are already visible outside
    // their containing directory. The child uses a deliberately permissive umask.
    await wrapper.writeAsString(r'''#!/bin/sh
if [ -s "$2" ]; then
  parent=$(dirname "$2")
  if [ "$(uname)" = Darwin ]; then
    mode=$(stat -f '%Lp' "$parent")
  else
    mode=$(stat -c '%a' "$parent")
  fi
  if [ "$mode" != 700 ]; then
    echo 'Secret bytes were exposed before chmod' >&2
    exit 73
  fi
fi
exec /bin/chmod "$@"
''');
    await Process.run('/bin/chmod', ['+x', wrapper.path]);
    final script = File('${home.path}/write.dart');
    final source = File('lib/credentials.dart').absolute.uri;
    await script.writeAsString("""
import 'dart:io';
import '$source';
Future<void> main(List<String> args) => CredentialStore(homeDirectory: Directory(args.single)).write(
  const BlablaCredentials(server: 'https://blabla.example', token: 'test-secret'));
""");
    final result = await Process.run(
      '/bin/sh',
      [
        '-c',
        r'umask 022; exec "$@"',
        'credential-test',
        Platform.resolvedExecutable,
        script.path,
        home.path,
      ],
      environment: {
        'PATH': '${wrapper.parent.path}:${Platform.environment['PATH']}',
      },
    );
    expect(result.exitCode, 0, reason: '${result.stderr}');
    expect(
      (await CredentialStore(homeDirectory: home).read())?.token,
      'test-secret',
    );
    expect(
      await CredentialStore(homeDirectory: home).file.parent.list().length,
      1,
    );
  }, skip: Platform.isWindows);

  test('stores credentials outside a checkout at mode 0600', () async {
    final home = await Directory.systemTemp.createTemp('blabla-credentials-');
    addTearDown(() => home.delete(recursive: true));
    final store = CredentialStore(homeDirectory: home);

    await store.write(
      const BlablaCredentials(
        server: 'https://blabla.example',
        token: 'token-value',
      ),
    );

    expect((await store.file.stat()).mode & 63, 0);
    final credentials = await store.read();
    expect(credentials?.server, 'https://blabla.example');
    expect(credentials?.token, 'token-value');

    await store.write(
      const BlablaCredentials(
        server: 'https://next-blabla.example',
        token: 'replacement-token',
      ),
    );
    expect((await store.read())?.token, 'replacement-token');
  });

  test('refuses credentials made readable by another user', () async {
    final home = await Directory.systemTemp.createTemp('blabla-credentials-');
    addTearDown(() => home.delete(recursive: true));
    final store = CredentialStore(homeDirectory: home);
    await store.file.parent.create(recursive: true);
    await store.file.writeAsString(
      '{"server":"https://blabla.example","token":"token-value"}',
    );
    final chmod = await Process.run('chmod', ['644', store.file.path]);
    if (chmod.exitCode != 0) throw StateError('Could not set credential mode.');

    await expectLater(store.read(), throwsA(isA<RepositoryAdapterException>()));
  });
}
