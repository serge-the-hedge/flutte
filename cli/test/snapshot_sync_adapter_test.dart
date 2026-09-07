import 'dart:convert';
import 'dart:io';

import 'package:blabla_cli/cli_version.dart';
import 'package:blabla_cli/command_runner.dart';
import 'package:blabla_cli/snapshot_sync_adapter.dart';
import 'package:test/test.dart';

import '../bin/blabla.dart' show runCli;

void main() {
  for (final succeeded in [false, true]) {
    test(
      'sync CLI exits ${succeeded ? 0 : 1} for a ${succeeded ? 'published' : 'failed'} run',
      () async {
        final fixture = await SyncFixture.create();
        addTearDown(fixture.dispose);
        final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
        addTearDown(server.close);
        final output = <String>[];
        server.listen((request) async {
          await request.drain<void>();
          request.response.headers.contentType = ContentType.json;
          request.response.write(
            jsonEncode(
              request.method == 'GET'
                  ? {
                      'version': 1,
                      'canSubmit': true,
                      'setupIssues': [],
                      'repository': null,
                      'integrationBranch': 'develop',
                      'bindings': [
                        {
                          'localeCode': 'en',
                          'catalogPath':
                              'packages/brickit_generated/lib/l10n/intl_en.arb',
                          'isSource': true,
                        },
                      ],
                      'baseline': null,
                      'limits': {'maxFiles': 1000, 'maxBytes': 8388608},
                    }
                  : request.uri.path.endsWith('/snapshot-uploads')
                  ? {'sessionId': 'upload_1', 'maxFileBytes': 8388608}
                  : request.uri.path.endsWith('/file')
                  ? {}
                  : {
                      'version': 1,
                      'run': {
                        'id': 'run_1',
                        'status': succeeded ? 'succeeded' : 'failed',
                        'snapshotId': succeeded ? 'snapshot_1' : null,
                        'diagnosticCount': succeeded ? 0 : 1,
                        'diagnostics': succeeded
                            ? []
                            : [
                                {'message': 'Catalog rejected'},
                              ],
                        'unboundLocaleFileCount': 0,
                        'absentTargetLocaleCount': 0,
                      },
                    },
            ),
          );
          await request.response.close();
        });
        final code = await runCli(
          [
            'sync',
            '--checkout',
            fixture.root.path,
            '--server',
            'http://${server.address.address}:${server.port}',
            '--token',
            'test-token',
          ],
          environment: const {},
          write: output.add,
          writeError: output.add,
        );
        expect(code, succeeded ? 0 : 1);
        if (!succeeded) expect(output.join('\n'), contains('Catalog rejected'));
      },
    );
  }

  test('sync does not warn when the minimum CLI version is older', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(server.close);
    server.listen((request) async {
      request.response.headers.set('X-Blabla-Minimum-CLI-Version', '0.0.1');
      request.response.headers.contentType = ContentType.json;
      request.response.write(
        jsonEncode({
          'version': 1,
          'canSubmit': true,
          'setupIssues': [],
          'repository': null,
          'bindings': [],
          'baseline': null,
          'limits': {'maxFiles': 1000, 'maxBytes': 8388608},
        }),
      );
      await request.response.close();
    });
    final warnings = <String>[];
    await HttpSnapshotSyncGateway(
      baseUrl: Uri.parse('http://${server.address.address}:${server.port}'),
      token: 'test-token',
      onWarning: warnings.add,
    ).readContext();
    expect(warnings, isEmpty);
  });

  test(
    'reads bound catalogs and unbound sibling ARB files without writing',
    () async {
      final fixture = await SyncFixture.create();
      addTearDown(fixture.dispose);
      final gateway = RecordingSnapshotGateway(
        SnapshotSyncContext(
          version: 1,
          canSubmit: true,
          setupIssues: const [],
          repository: null,
          bindings: const [
            SnapshotBinding(
              localeCode: 'en',
              catalogPath: 'packages/brickit_generated/lib/l10n/intl_en.arb',
              isSource: true,
            ),
            SnapshotBinding(
              localeCode: 'de',
              catalogPath: 'packages/brickit_generated/lib/l10n/intl_de.arb',
              isSource: false,
            ),
          ],
          baseline: null,
          maxFiles: 1000,
          maxBytes: 8 * 1024 * 1024,
        ),
      );

      final originalHead = await fixture.git(['rev-parse', 'HEAD']);
      final output = <String>[];
      final receipt = await RepositorySyncAdapter().sync(
        checkout: fixture.root,
        gateway: gateway,
        write: output.add,
      );

      expect(receipt.status, 'succeeded');
      expect(
        gateway.repository,
        'https://github.com/brickit-app/brickit-flutter.git',
      );
      expect(gateway.commit, originalHead);
      expect(
        gateway.files.map((file) => file.catalogPath),
        unorderedEquals([
          'packages/brickit_generated/lib/l10n/intl_en.arb',
          'packages/brickit_generated/lib/l10n/intl_de.arb',
          'packages/brickit_generated/lib/l10n/intl_fr.arb',
        ]),
      );
      expect(
        gateway.files
            .singleWhere((file) => file.catalogPath.endsWith('intl_fr.arb'))
            .content,
        contains('Bonjour'),
      );
      expect(await fixture.git(['rev-parse', 'HEAD']), originalHead);
      expect(output.first, contains('Sync succeeded'));
    },
  );

  test('refuses sync from a non-integration branch', () async {
    final fixture = await SyncFixture.create();
    addTearDown(fixture.dispose);
    await fixture.git(['switch', '-c', 'feature/localization']);
    final gateway = RecordingSnapshotGateway(
      SnapshotSyncContext(
        version: 1,
        canSubmit: true,
        setupIssues: const [],
        repository: null,
        bindings: const [
          SnapshotBinding(
            localeCode: 'en',
            catalogPath: 'packages/brickit_generated/lib/l10n/intl_en.arb',
            isSource: true,
          ),
        ],
        baseline: null,
        maxFiles: 1000,
        maxBytes: 8 * 1024 * 1024,
      ),
    );

    await expectLater(
      RepositorySyncAdapter().sync(
        checkout: fixture.root,
        gateway: gateway,
        write: (_) {},
      ),
      throwsA(
        isA<RepositoryAdapterException>().having(
          (error) => error.message,
          'message',
          allOf(contains('feature/localization'), contains('develop')),
        ),
      ),
    );
    expect(gateway.commit, isNull);
  });

  test(
    'refuses a modified bound catalog instead of mislabeling its bytes',
    () async {
      final fixture = await SyncFixture.create();
      addTearDown(fixture.dispose);
      await fixture.write(
        'packages/brickit_generated/lib/l10n/intl_en.arb',
        '{"@@locale":"en","greeting":"Uncommitted"}',
      );
      final gateway = RecordingSnapshotGateway(_syncContext());

      await expectLater(
        RepositorySyncAdapter().sync(
          checkout: fixture.root,
          gateway: gateway,
          write: (_) {},
        ),
        throwsA(
          isA<RepositoryAdapterException>().having(
            (error) => error.message,
            'message',
            allOf(contains('committed blob'), contains('intl_en.arb')),
          ),
        ),
      );
      expect(gateway.commit, isNull);
    },
  );

  test(
    'ignores an untracked sibling catalog outside Git Release Truth',
    () async {
      final fixture = await SyncFixture.create();
      addTearDown(fixture.dispose);
      await fixture.write(
        'packages/brickit_generated/lib/l10n/intl_es.arb',
        '{"@@locale":"es","greeting":"Hola"}',
      );
      final gateway = RecordingSnapshotGateway(_syncContext());

      await RepositorySyncAdapter().sync(
        checkout: fixture.root,
        gateway: gateway,
        write: (_) {},
      );
      expect(
        gateway.files.map((file) => file.catalogPath),
        isNot(contains('packages/brickit_generated/lib/l10n/intl_es.arb')),
      );
    },
  );

  test(
    'detects a changed catalog even when Git marks it assume-unchanged',
    () async {
      final fixture = await SyncFixture.create();
      addTearDown(fixture.dispose);
      const path = 'packages/brickit_generated/lib/l10n/intl_en.arb';
      await fixture.git(['update-index', '--assume-unchanged', path]);
      await fixture.write(path, '{"@@locale":"en","greeting":"Hidden"}');
      final gateway = RecordingSnapshotGateway(_syncContext());

      await expectLater(
        RepositorySyncAdapter().sync(
          checkout: fixture.root,
          gateway: gateway,
          write: (_) {},
        ),
        throwsA(
          isA<RepositoryAdapterException>().having(
            (error) => error.message,
            'message',
            allOf(contains('committed blob'), contains('intl_en.arb')),
          ),
        ),
      );
      expect(gateway.commit, isNull);
    },
  );

  test('hashes and submits the same captured catalog bytes', () async {
    final fixture = await SyncFixture.create();
    addTearDown(fixture.dispose);
    const path = 'packages/brickit_generated/lib/l10n/intl_en.arb';
    final gateway = RecordingSnapshotGateway(_syncContext());
    final runner = MutatingHashRunner(
      catalogPath: path,
      replacement: '{"@@locale":"en","greeting":"Changed during sync"}',
    );

    await RepositorySyncAdapter(
      runner: runner,
    ).sync(checkout: fixture.root, gateway: gateway, write: (_) {});

    expect(runner.mutated, isTrue);
    expect(
      gateway.files.singleWhere((file) => file.catalogPath == path).content,
      '{"@@locale":"en","greeting":"Hello"}',
    );
  });

  test('accepts working-tree line endings normalized by Git', () async {
    final fixture = await SyncFixture.create();
    addTearDown(fixture.dispose);
    const path = 'packages/brickit_generated/lib/l10n/intl_en.arb';
    await fixture.write('.gitattributes', '*.arb text eol=lf\n');
    await fixture.write(
      path,
      '{\n  "@@locale": "en",\n  "greeting": "Hello"\n}\n',
    );
    await fixture.git(['add', '.gitattributes', path]);
    await fixture.git(['commit', '-m', 'normalize catalogs']);
    await fixture.write(
      path,
      '{\r\n  "@@locale": "en",\r\n  "greeting": "Hello"\r\n}\r\n',
    );
    final gateway = RecordingSnapshotGateway(_syncContext());

    await RepositorySyncAdapter().sync(
      checkout: fixture.root,
      gateway: gateway,
      write: (_) {},
    );

    expect(
      gateway.files.singleWhere((file) => file.catalogPath == path).content,
      contains('\r\n'),
    );
  });

  test(
    'preserves whitespace and newlines in committed catalog paths',
    () async {
      final fixture = await SyncFixture.create();
      addTearDown(fixture.dispose);
      const path =
          'packages/brickit_generated/lib/l10n/ intl_pt\n translation .arb';
      await fixture.write(path, '{"@@locale":"pt","greeting":"Olá"}');
      await fixture.git(['add', '--', path]);
      await fixture.git(['commit', '-m', 'add unusual catalog path']);
      final gateway = RecordingSnapshotGateway(_syncContext());

      await RepositorySyncAdapter().sync(
        checkout: fixture.root,
        gateway: gateway,
        write: (_) {},
      );

      expect(gateway.files.map((file) => file.catalogPath), contains(path));
    },
  );

  test('refuses a catalog replaced by a symbolic link', () async {
    final fixture = await SyncFixture.create();
    addTearDown(fixture.dispose);
    const relative = 'packages/brickit_generated/lib/l10n/intl_en.arb';
    final path = '${fixture.root.path}${Platform.pathSeparator}$relative';
    await File(path).delete();
    await Link(path).create('intl_fr.arb');
    final gateway = RecordingSnapshotGateway(_syncContext());

    await expectLater(
      RepositorySyncAdapter().sync(
        checkout: fixture.root,
        gateway: gateway,
        write: (_) {},
      ),
      throwsA(
        isA<RepositoryAdapterException>().having(
          (error) => error.message,
          'message',
          allOf(contains('symbolic link'), contains('intl_en.arb')),
        ),
      ),
    );
    expect(gateway.commit, isNull);
  });

  test('derives descendant lineage from local Git history', () async {
    final fixture = await SyncFixture.create();
    addTearDown(fixture.dispose);
    final baseline = await fixture.git(['rev-parse', 'HEAD']);
    await fixture.write(
      'packages/brickit_generated/lib/l10n/intl_en.arb',
      '{"@@locale":"en","greeting":"Hello again"}',
    );
    await fixture.git(['add', '.']);
    await fixture.git(['commit', '-m', 'next catalog']);
    final current = await fixture.git(['rev-parse', 'HEAD']);
    final gateway = RecordingSnapshotGateway(
      SnapshotSyncContext(
        version: 1,
        canSubmit: true,
        setupIssues: const [],
        repository: 'github.com/brickit-app/brickit-flutter',
        bindings: const [
          SnapshotBinding(
            localeCode: 'en',
            catalogPath: 'packages/brickit_generated/lib/l10n/intl_en.arb',
            isSource: true,
          ),
        ],
        baseline: SyncBaseline(
          id: 'baseline',
          repository: 'github.com/brickit-app/brickit-flutter',
          commit: baseline,
          manifestHash: List.filled(64, 'a').join(),
          kind: 'baseline',
        ),
        maxFiles: 1000,
        maxBytes: 8 * 1024 * 1024,
      ),
    );

    await RepositorySyncAdapter().sync(
      checkout: fixture.root,
      gateway: gateway,
      write: (_) {},
    );

    expect(gateway.commit, current);
    expect(gateway.lineage, isNotNull);
    expect(gateway.lineage!.relationship, 'descendant');
    expect(gateway.lineage!.baselineCommit, baseline);
    expect(gateway.lineage!.mergeBase, baseline);
  });

  test('speaks the repository-adapter wire contract', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    addTearDown(server.close);
    final requests = <String>[];
    server.listen((request) async {
      expect(
        request.headers.value(HttpHeaders.authorizationHeader),
        'Bearer sync-token',
      );
      expect(request.headers.value('X-Blabla-CLI-Version'), blablaCliVersion);
      expect(
        request.headers.value('X-Blabla-CLI-Protocol'),
        '$blablaCliProtocol',
      );
      requests.add(request.uri.path);
      request.response.headers.contentType = ContentType.json;
      if (request.method == 'GET') {
        request.response.write(
          jsonEncode({
            'version': 1,
            'canSubmit': true,
            'setupIssues': [],
            'repository': null,
            'integrationBranch': 'develop',
            'bindings': [
              {
                'localeCode': 'en',
                'catalogPath': 'intl_en.arb',
                'isSource': true,
              },
            ],
            'baseline': null,
            'limits': {'maxFiles': 1000, 'maxBytes': 8388608},
          }),
        );
      } else if (request.uri.path.endsWith('/snapshot-uploads')) {
        final body =
            jsonDecode(await utf8.decoder.bind(request).join())
                as Map<String, dynamic>;
        expect(body['expectedFiles'], 1);
        expect(body.containsKey('files'), isFalse);
        request.response.write(
          jsonEncode({'sessionId': 'upload_1', 'maxFileBytes': 8388608}),
        );
      } else if (request.uri.path.endsWith('/file')) {
        final body =
            jsonDecode(await utf8.decoder.bind(request).join())
                as Map<String, dynamic>;
        expect(body['catalogPath'], 'intl_en.arb');
        expect(body['content'], '{}');
        expect(
          body['contentHash'],
          '44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a',
        );
        request.response.write('{}');
      } else {
        expect(await utf8.decoder.bind(request).join(), contains('upload_1'));
        request.response.write(
          jsonEncode({
            'version': 1,
            'run': {
              'id': 'run_1',
              'status': 'succeeded',
              'snapshotId': 'snapshot_1',
              'diagnosticCount': 0,
              'diagnostics': [],
              'unboundLocaleFileCount': 0,
              'absentTargetLocaleCount': 0,
            },
          }),
        );
      }
      await request.response.close();
    });

    final gateway = HttpSnapshotSyncGateway(
      baseUrl: Uri.parse('http://${server.address.address}:${server.port}'),
      token: 'sync-token',
    );
    final context = await gateway.readContext();
    final receipt = await gateway.submit(
      repository: 'repo',
      commit: 'commit',
      files: const [SnapshotFile(catalogPath: 'intl_en.arb', content: '{}')],
    );

    expect(context.canSubmit, isTrue);
    expect(context.integrationBranch, 'develop');
    expect(receipt.snapshotId, 'snapshot_1');
    expect(requests, [
      '/api/repository-adapter/v1/snapshot-context',
      '/api/repository-adapter/v1/snapshot-uploads',
      '/api/repository-adapter/v1/snapshot-uploads/file',
      '/api/repository-adapter/v1/snapshot-uploads/finalize',
    ]);
  });
}

SnapshotSyncContext _syncContext() => SnapshotSyncContext(
  version: 1,
  canSubmit: true,
  setupIssues: const [],
  repository: null,
  bindings: const [
    SnapshotBinding(
      localeCode: 'en',
      catalogPath: 'packages/brickit_generated/lib/l10n/intl_en.arb',
      isSource: true,
    ),
  ],
  baseline: null,
  maxFiles: 1000,
  maxBytes: 8 * 1024 * 1024,
);

class RecordingSnapshotGateway implements SnapshotSyncGateway {
  RecordingSnapshotGateway(this.context);

  final SnapshotSyncContext context;
  String? repository;
  String? commit;
  List<SnapshotFile> files = const [];
  SnapshotLineage? lineage;

  @override
  Future<SnapshotSyncContext> readContext() async => context;

  @override
  Future<SnapshotSyncReceipt> submit({
    required String repository,
    required String commit,
    required List<SnapshotFile> files,
    SnapshotLineage? lineage,
  }) async {
    this.repository = repository;
    this.commit = commit;
    this.files = files;
    this.lineage = lineage;
    return const SnapshotSyncReceipt(
      version: 1,
      runId: 'run_1',
      status: 'succeeded',
      snapshotId: 'snapshot_1',
      diagnosticCount: 0,
      diagnostics: [],
      unboundLocaleFileCount: 1,
      absentTargetLocaleCount: 0,
    );
  }
}

class MutatingHashRunner implements CommandRunner {
  MutatingHashRunner({required this.catalogPath, required this.replacement});

  final String catalogPath;
  final String replacement;
  final CommandRunner _delegate = const SystemCommandRunner();
  bool mutated = false;

  @override
  Future<CommandResult> run(
    String executable,
    List<String> arguments, {
    required String workingDirectory,
    List<int>? stdin,
  }) async {
    if (!mutated &&
        executable == 'git' &&
        arguments.contains('hash-object') &&
        arguments.contains('--path=$catalogPath')) {
      mutated = true;
      await File(
        '$workingDirectory${Platform.pathSeparator}$catalogPath',
      ).writeAsString(replacement);
    }
    return _delegate.run(
      executable,
      arguments,
      workingDirectory: workingDirectory,
      stdin: stdin,
    );
  }
}

class SyncFixture {
  SyncFixture._(this.root);

  final Directory root;

  static Future<SyncFixture> create() async {
    final root = await Directory.systemTemp.createTemp('blabla-sync-');
    final fixture = SyncFixture._(root);
    await fixture.write(
      'packages/brickit_generated/lib/l10n/intl_en.arb',
      '{"@@locale":"en","greeting":"Hello"}',
    );
    await fixture.write(
      'packages/brickit_generated/lib/l10n/intl_de.arb',
      '{"@@locale":"de","greeting":"Hallo"}',
    );
    await fixture.write(
      'packages/brickit_generated/lib/l10n/intl_fr.arb',
      '{"@@locale":"fr","greeting":"Bonjour"}',
    );
    await fixture.git(['init']);
    await fixture.git(['checkout', '-b', 'develop']);
    await fixture.git(['config', 'user.name', 'Blabla test']);
    await fixture.git(['config', 'user.email', 'blabla@example.test']);
    await fixture.git([
      'remote',
      'add',
      'origin',
      'https://github.com/brickit-app/brickit-flutter.git',
    ]);
    await fixture.git(['add', '.']);
    await fixture.git(['commit', '-m', 'fixture']);
    return fixture;
  }

  Future<void> write(String relative, String contents) async {
    final file = File('${root.path}${Platform.pathSeparator}$relative');
    await file.parent.create(recursive: true);
    await file.writeAsString(contents);
  }

  Future<String> git(List<String> arguments) async {
    final result = await Process.run(
      'git',
      arguments,
      workingDirectory: root.path,
    );
    if (result.exitCode != 0) {
      throw StateError('git ${arguments.join(' ')} failed: ${result.stderr}');
    }
    return (result.stdout as String).trim();
  }

  Future<void> dispose() => root.delete(recursive: true);
}
