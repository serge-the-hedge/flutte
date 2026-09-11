import 'dart:io';
import 'dart:convert';

import 'package:blabla_cli/locale_proposal_adapter.dart';
import 'package:test/test.dart';

void main() {
  test(
    'local FVM executable survives moving into a staging directory',
    () async {
      final fixture = await ToolchainFixture.create(parent: Directory('.'));
      addTearDown(fixture.dispose);
      await fixture.sdk('.fvm/flutter_sdk', 'Flutter 3.44.6');
      final resolved = await FlutterToolchainResolver(
        environment: const {},
      ).resolve(fixture.root);
      final result = await Process.run(resolved.executable, [
        '--version',
      ], workingDirectory: Directory.systemTemp.path);
      expect(result.exitCode, 0);
      expect(result.stdout, contains('Flutter 3.44.6'));
      expect(File(resolved.executable).isAbsolute, isTrue);
    },
  );

  test(
    'explicit SDK wins and reports version plus committed constraint',
    () async {
      final fixture = await ToolchainFixture.create();
      addTearDown(fixture.dispose);
      final explicit = await fixture.sdk('explicit', 'Flutter 3.44.6');
      await fixture.sdk('from-environment', 'Flutter 9.9.9');

      final resolved = await FlutterToolchainResolver(
        environment: {'FLUTTER_ROOT': fixture.path('from-environment')},
      ).resolve(fixture.checkout, explicitSdk: explicit.path);

      expect(
        resolved.executable,
        await File(fixture.path('explicit/bin/flutter')).resolveSymbolicLinks(),
      );
      expect(resolved.version, 'Flutter 3.44.6');
      expect(resolved.description, contains('environment.flutter: ^3.44.0'));
    },
  );

  test('repository SDK wins over FLUTTER_ROOT', () async {
    final fixture = await ToolchainFixture.create();
    addTearDown(fixture.dispose);
    final local = await fixture.sdk('.fvm/flutter_sdk', 'Flutter 3.44.6');
    final ambient = await fixture.sdk('ambient', 'Flutter 9.9.9');
    final resolved = await FlutterToolchainResolver(
      environment: {'FLUTTER_ROOT': ambient.path},
    ).resolve(fixture.root);
    expect(
      resolved.executable,
      await File('${local.path}/bin/flutter').resolveSymbolicLinks(),
    );
    expect(resolved.source, 'repository FVM');
  });

  test('resolves FVM to a fixed SDK executable before staging', () async {
    final fixture = await ToolchainFixture.create();
    addTearDown(fixture.dispose);
    await File(fixture.path('.fvmrc')).writeAsString('{"flutter":"3.44.6"}');
    final sdk = await fixture.sdk('installed-sdk', 'Flutter 3.44.6');
    final runner = FvmRunner(await sdk.resolveSymbolicLinks());

    final resolved = await FlutterToolchainResolver(
      environment: const {},
      runner: runner,
    ).resolve(fixture.checkout);

    expect(
      resolved.executable,
      '${await sdk.resolveSymbolicLinks()}/bin/flutter',
    );
    expect(resolved.argumentsPrefix, isEmpty);
    expect(resolved.sdkPath, await sdk.resolveSymbolicLinks());
    expect(resolved.version, 'Flutter 3.44.6');
    expect(runner.calls, contains(equals(['fvm', '--version'])));
    expect(
      runner.calls,
      contains(
        equals([
          '${await sdk.resolveSymbolicLinks()}/bin/flutter',
          '--version',
        ]),
      ),
    );
  });
  test(
    'missing configured SDK gives setup guidance instead of ambient fallback',
    () async {
      final fixture = await ToolchainFixture.create();
      addTearDown(fixture.dispose);
      await File(fixture.path('.fvmrc')).writeAsString('{"flutter":"3.47.0"}');
      final ambient = await fixture.sdk('ambient', 'Flutter 3.44.6');
      await expectLater(
        FlutterToolchainResolver(
          environment: {'FLUTTER_ROOT': ambient.path},
          runner: FvmRunner(fixture.path('missing')),
        ).resolve(fixture.root),
        throwsA(
          isA<RepositoryAdapterException>().having(
            (error) => error.message,
            'guidance',
            contains('fvm install'),
          ),
        ),
      );
    },
  );

  test(
    'stale repository SDK link names the pinned version and repair command',
    () async {
      final fixture = await ToolchainFixture.create();
      addTearDown(fixture.dispose);
      await fixture.sdk('.fvm/flutter_sdk', 'Flutter 3.44.6');
      await File(fixture.path('.fvmrc')).writeAsString('{"flutter":"3.47.0"}');
      await expectLater(
        FlutterToolchainResolver(environment: {}).resolve(fixture.root),
        throwsA(
          isA<RepositoryAdapterException>().having(
            (error) => error.message,
            'repair',
            contains('fvm use 3.47.0'),
          ),
        ),
      );
    },
  );

  test(
    'inline YAML constraint prevents an incompatible automatic refresh',
    () async {
      final fixture = await ToolchainFixture.create();
      addTearDown(fixture.dispose);
      final sdk = await fixture.sdk('explicit', 'Flutter 3.44.6');
      await File(
        fixture.path('pubspec.yaml'),
      ).writeAsString('environment: {sdk: ^3.12.0, flutter: ^3.47.0}');
      final resolved = await FlutterToolchainResolver(
        environment: {},
      ).resolve(fixture.root, explicitSdk: sdk.path);
      expect(resolved.projectConstraint, '^3.47.0');
      expect(resolved.canRefreshGeneratedOutput, isFalse);
    },
  );

  test('refresh requires an intended SDK and a compatible known version', () {
    ResolvedFlutter sdk(String source, String version) => ResolvedFlutter(
      executable: '/flutter',
      argumentsPrefix: [],
      sdkPath: '/',
      source: source,
      version: version,
      projectConstraint: '^3.47.0',
    );
    expect(
      sdk('repository FVM', 'Flutter 3.47.0').canRefreshGeneratedOutput,
      isTrue,
    );
    expect(
      sdk('--flutter-sdk', 'Flutter 3.47.2').canRefreshGeneratedOutput,
      isTrue,
    );
    expect(
      sdk('--flutter-sdk', 'Flutter 3.44.6').canRefreshGeneratedOutput,
      isFalse,
    );
    expect(sdk('PATH', 'Flutter 3.47.0').canRefreshGeneratedOutput, isFalse);
    expect(
      sdk('repository FVM', 'unavailable').canRefreshGeneratedOutput,
      isFalse,
    );
  });
}

class ToolchainFixture {
  ToolchainFixture._(this.root);

  final Directory root;
  Directory get checkout => root;

  static Future<ToolchainFixture> create({Directory? parent}) async {
    final root = await (parent ?? Directory.systemTemp).createTemp(
      'blabla-flutter-sdk-',
    );
    await File('${root.path}/pubspec.yaml').writeAsString('''name: brickit
environment:
  sdk: ^3.12.0
  flutter: ^3.44.0
''');
    return ToolchainFixture._(root);
  }

  Future<Directory> sdk(String name, String version) async {
    final root = Directory(path(name));
    final flutter = File('${root.path}/bin/flutter');
    await flutter.parent.create(recursive: true);
    await flutter.writeAsString('''#!/bin/sh
if [ "\$1" = "--version" ]; then
  echo '$version'
  exit 0
fi
exit 0
''');
    final chmod = await Process.run('chmod', ['+x', flutter.path]);
    if (chmod.exitCode != 0) throw StateError('Could not create fake Flutter.');
    return root;
  }

  String path(String relative) => '${root.path}/$relative';

  Future<void> dispose() => root.delete(recursive: true);
}

class FvmRunner implements CommandRunner {
  FvmRunner(this.sdkPath);
  final String sdkPath;
  final List<List<String>> calls = [];

  @override
  Future<CommandResult> run(
    String executable,
    List<String> arguments, {
    required String workingDirectory,
    List<int>? stdin,
  }) async {
    calls.add([executable, ...arguments]);
    if (executable == 'fvm' && arguments.join(' ') == '--version') {
      return const CommandResult(exitCode: 0, stdout: '3.2.1\n', stderr: '');
    }
    if (executable == '$sdkPath/bin/flutter' &&
        arguments.join(' ') == '--version') {
      return const CommandResult(
        exitCode: 0,
        stdout: 'Flutter 3.44.6\n',
        stderr: '',
      );
    }
    if (executable == 'fvm' && arguments.join(' ') == 'api project') {
      return CommandResult(
        exitCode: 0,
        stdout: jsonEncode({
          'project': {'localVersionSymlinkPath': sdkPath},
        }),
        stderr: '',
      );
    }
    return const CommandResult(exitCode: 1, stdout: '', stderr: 'unexpected');
  }
}
