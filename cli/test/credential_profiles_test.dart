import 'dart:io';

import 'package:blabla_cli/credentials.dart';
import 'package:blabla_cli/command_runner.dart';
import 'package:test/test.dart';

import '../bin/blabla.dart' as cli;

void main() {
  late Directory home;
  late CredentialStore store;
  const credentials = BlablaCredentials(
    server: 'https://blabla.example',
    token: 'secret-fixture',
  );
  setUp(() async {
    home = await Directory.systemTemp.createTemp('blabla-profiles-test-');
    store = CredentialStore(homeDirectory: home);
  });
  tearDown(() => home.delete(recursive: true));

  test(
    'private named profiles require deliberate replacement and can be removed',
    () async {
      await store.write(credentials, profile: 'writer');
      expect((await store.profileFile('writer').stat()).mode & 511, 384);
      expect((await store.profileFile('writer').parent.stat()).mode & 511, 448);
      await expectLater(
        store.write(credentials, profile: 'writer'),
        throwsA(isA<RepositoryAdapterException>()),
      );
      await store.write(
        const BlablaCredentials(
          server: 'https://other.example',
          token: 'replacement',
        ),
        profile: 'writer',
        replace: true,
      );
      expect((await store.read(profile: 'writer'))?.token, 'replacement');
      await store.write(credentials, profile: 'reviewer');
      expect(await store.listProfiles(), ['reviewer', 'writer']);
      await store.removeProfile('writer');
      expect(await store.listProfiles(), ['reviewer']);
      await expectLater(
        store.read(profile: 'writer'),
        throwsA(isA<RepositoryAdapterException>()),
      );
    },
  );

  test(
    'explicit profile rejects every ambient credential pair without falling back',
    () async {
      await store.write(credentials);
      for (final variable in [
        'BLABLA_TOKEN',
        'BLABLA_API_URL',
        'BLABLA_AGENT_TOKEN',
        'BLABLA_AGENT_URL',
      ]) {
        await expectLater(
          resolveCredentials(
            options: {'profile': 'missing'},
            environment: {variable: 'fixture'},
            store: store,
          ),
          throwsA(isA<RepositoryAdapterException>()),
        );
      }
      await expectLater(
        resolveCredentials(
          options: {'server': credentials.server},
          environment: {'BLABLA_TOKEN': credentials.token},
          store: store,
        ),
        throwsA(isA<RepositoryAdapterException>()),
      );
      await expectLater(
        resolveCredentials(
          options: {'profile': 'missing'},
          environment: {},
          store: store,
        ),
        throwsA(isA<RepositoryAdapterException>()),
      );
    },
  );

  test('relative homes and traversal names are refused', () async {
    expect(
      () => CredentialStore.forEnvironment({'HOME': 'relative'}),
      throwsA(isA<RepositoryAdapterException>()),
    );
    await expectLater(
      CredentialStore(homeDirectory: Directory('relative')).read(),
      throwsA(isA<RepositoryAdapterException>()),
    );
    for (final name in ['../writer', '/tmp/writer', 'writer\n', 'Writer', '']) {
      expect(
        () => store.profileFile(name),
        throwsA(isA<RepositoryAdapterException>()),
      );
    }
  });

  test(
    'symlink files and directories cannot be read, replaced, or removed',
    () async {
      await store.write(credentials, profile: 'writer');
      final file = store.profileFile('writer');
      final original = await file.readAsString();
      final outside = File('${home.path}/outside');
      await file.rename(outside.path);
      await Link(file.path).create(outside.path);
      await expectLater(
        store.read(profile: 'writer'),
        throwsA(isA<RepositoryAdapterException>()),
      );
      await expectLater(
        store.write(credentials, profile: 'writer', replace: true),
        throwsA(isA<RepositoryAdapterException>()),
      );
      await expectLater(
        store.removeProfile('writer'),
        throwsA(isA<RepositoryAdapterException>()),
      );
      expect(await outside.readAsString(), original);
      await Link(file.path).delete();
      await file.parent.delete();
      await Link(file.parent.path).create(home.path);
      await expectLater(
        store.listProfiles(),
        throwsA(isA<RepositoryAdapterException>()),
      );
    },
  );

  test(
    'unsafe modes, oversized files, and malformed secrets fail closed',
    () async {
      await store.write(credentials, profile: 'writer');
      final file = store.profileFile('writer');
      await Process.run('/bin/chmod', ['644', file.path]);
      await expectLater(
        store.read(profile: 'writer'),
        throwsA(isA<RepositoryAdapterException>()),
      );
      await Process.run('/bin/chmod', ['600', file.path]);
      await file.writeAsString('x' * (maxCredentialFileBytes + 1));
      await expectLater(
        store.read(profile: 'writer'),
        throwsA(isA<RepositoryAdapterException>()),
      );
      await file.writeAsString('{"token":"secret-fixture"');
      try {
        await store.read(profile: 'writer');
        fail('Expected rejection');
      } catch (error) {
        expect(error.toString(), isNot(contains('secret-fixture')));
      }
    },
  );

  test(
    'login prompts or consumes stdin explicitly and never prints a token',
    () async {
      final output = <String>[];
      for (final fromStdin in [false, true]) {
        expect(
          await cli.runCli(
            [
              'login',
              '--profile',
              fromStdin ? 'stdin' : 'prompt',
              '--server',
              credentials.server,
              if (fromStdin) '--token-stdin',
            ],
            environment: {'HOME': home.path},
            write: output.add,
            writeError: output.add,
            readToken: (requestedStdin) async {
              expect(requestedStdin, fromStdin);
              return credentials.token;
            },
          ),
          0,
        );
      }
      expect(output.join(), isNot(contains(credentials.token)));
      expect((await store.read(profile: 'prompt'))?.token, credentials.token);
      expect((await store.read(profile: 'stdin'))?.token, credentials.token);
      expect(
        await cli.runCli(
          [
            'login',
            '--profile',
            'mixed',
            '--server',
            credentials.server,
            '--token-stdin',
          ],
          environment: {'HOME': home.path, 'BLABLA_TOKEN': credentials.token},
          writeError: output.add,
          readToken: (_) async => throw StateError('Must not prompt'),
        ),
        1,
      );
      expect(output.join(), isNot(contains(credentials.token)));
    },
  );
  test('malformed arguments never echo a misplaced secret', () async {
    for (final args in [
      ['login', '--token-stdin', 'secret-fixture'],
      ['login', '--secret-fixture'],
      ['secret-fixture'],
    ]) {
      final errors = <String>[];
      expect(
        await cli.runCli(
          args,
          environment: {'HOME': home.path},
          writeError: errors.add,
          write: (_) {},
        ),
        1,
      );
      expect(errors.join(), isNot(contains('secret-fixture')));
    }
  });
}
