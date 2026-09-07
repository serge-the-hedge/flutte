import 'dart:convert';
import 'dart:io';

import 'command_runner.dart';

/// The Flutter invocation selected for one delivery. The version and the
/// project's declared constraint are diagnostic only: reproducible
/// `gen-l10n` output is the actual compatibility check.
class ResolvedFlutter {
  const ResolvedFlutter({
    required this.executable,
    required this.argumentsPrefix,
    required this.sdkPath,
    required this.version,
    this.projectConstraint,
  });

  final String executable;
  final List<String> argumentsPrefix;
  final String sdkPath;
  final String version;
  final String? projectConstraint;

  String get description {
    final constraint = projectConstraint == null
        ? ''
        : '; project environment.flutter: $projectConstraint (informational)';
    return 'Resolved Flutter SDK: $sdkPath; version: $version$constraint';
  }
}

/// Resolves the repository's Flutter toolchain in the order documented by the
/// delivery contract. Version text is deliberately never a gate: preflight
/// regeneration decides whether this SDK is compatible with this checkout.
class FlutterToolchainResolver {
  FlutterToolchainResolver({
    CommandRunner runner = const SystemCommandRunner(),
    Map<String, String>? environment,
  }) : _runner = runner,
       _environment = environment ?? Platform.environment;

  final CommandRunner _runner;
  final Map<String, String> _environment;

  Future<ResolvedFlutter> resolve(
    Directory checkout, {
    String? explicitSdk,
  }) async {
    checkout = checkout.absolute;
    final candidate = await _resolveCandidate(checkout, explicitSdk);
    final version = await _version(checkout, candidate);
    final constraint = await _projectFlutterConstraint(checkout);
    return ResolvedFlutter(
      executable: candidate.executable,
      argumentsPrefix: candidate.argumentsPrefix,
      sdkPath: candidate.sdkPath,
      version: version,
      projectConstraint: constraint,
    );
  }

  Future<ResolvedFlutter> _resolveCandidate(
    Directory checkout,
    String? explicitSdk,
  ) async {
    if (explicitSdk != null && explicitSdk.isNotEmpty) {
      return await _sdkRoot(explicitSdk, '--flutter-sdk', mustExist: true);
    }

    final flutterRoot = _environment['FLUTTER_ROOT'];
    if (flutterRoot != null && flutterRoot.isNotEmpty) {
      return await _sdkRoot(flutterRoot, 'FLUTTER_ROOT', mustExist: true);
    }

    final localSdk = Directory(
      '${checkout.path}${Platform.pathSeparator}.fvm${Platform.pathSeparator}flutter_sdk',
    );
    final localFlutter = File(
      '${localSdk.path}${Platform.pathSeparator}bin${Platform.pathSeparator}flutter',
    );
    if (await localFlutter.exists()) {
      return ResolvedFlutter(
        executable: localFlutter.path,
        argumentsPrefix: const [],
        sdkPath: localSdk.path,
        version: 'unavailable',
      );
    }

    final fvmrc = File('${checkout.path}${Platform.pathSeparator}.fvmrc');
    if (await fvmrc.exists() && await _fvmIsAvailable(checkout)) {
      return ResolvedFlutter(
        executable: 'fvm',
        argumentsPrefix: const ['flutter'],
        sdkPath: await _fvmSdkPath(checkout, fvmrc),
        version: 'unavailable',
      );
    }

    final onPath = await _tryRun(checkout, 'which', const ['flutter']);
    final path = onPath?.exitCode == 0 && onPath!.stdout.trim().isNotEmpty
        ? onPath.stdout.trim().split('\n').first
        : 'flutter on PATH';
    return ResolvedFlutter(
      executable: 'flutter',
      argumentsPrefix: const [],
      sdkPath: path,
      version: 'unavailable',
    );
  }

  Future<ResolvedFlutter> _sdkRoot(
    String root,
    String source, {
    required bool mustExist,
  }) async {
    final sdk = Directory(root).absolute;
    final executable = File(
      '${sdk.path}${Platform.pathSeparator}bin${Platform.pathSeparator}flutter',
    );
    if (mustExist && !await executable.exists()) {
      throw RepositoryAdapterException(
        '$source must name a Flutter SDK directory containing bin/flutter.',
      );
    }
    return ResolvedFlutter(
      executable: executable.path,
      argumentsPrefix: const [],
      sdkPath: sdk.path,
      version: 'unavailable',
    );
  }

  Future<bool> _fvmIsAvailable(Directory checkout) async {
    final result = await _tryRun(checkout, 'fvm', const ['--version']);
    return result?.exitCode == 0;
  }

  Future<String> _fvmSdkPath(Directory checkout, File fvmrc) async {
    final result = await _tryRun(checkout, 'fvm', const ['api', 'project']);
    if (result?.exitCode != 0) return '${fvmrc.path} via fvm';
    try {
      final decoded = jsonDecode(result!.stdout);
      if (decoded is Map &&
          decoded['project'] is Map &&
          (decoded['project'] as Map)['localVersionSymlinkPath'] is String) {
        final path =
            (decoded['project'] as Map)['localVersionSymlinkPath'] as String;
        if (path.isNotEmpty) return path;
      }
    } on FormatException {
      // FVM still resolves the command; the configuration path remains useful.
    }
    return '${fvmrc.path} via fvm';
  }

  Future<String> _version(Directory checkout, ResolvedFlutter flutter) async {
    final result = await _tryRun(checkout, flutter.executable, [
      ...flutter.argumentsPrefix,
      '--version',
    ]);
    if (result == null || result.exitCode != 0) return 'unavailable';
    for (final line in result.stdout.split('\n')) {
      final value = line.trim();
      if (value.isNotEmpty) return value;
    }
    return 'unavailable';
  }

  Future<String?> _projectFlutterConstraint(Directory checkout) async {
    final pubspec = File(
      '${checkout.path}${Platform.pathSeparator}pubspec.yaml',
    );
    if (!await pubspec.exists()) return null;
    var inEnvironment = false;
    for (final line in (await pubspec.readAsLines())) {
      if (RegExp(r'^environment\s*:\s*$').hasMatch(line)) {
        inEnvironment = true;
        continue;
      }
      if (inEnvironment &&
          RegExp(r'^\S').hasMatch(line) &&
          !RegExp(r'^\s').hasMatch(line)) {
        inEnvironment = false;
      }
      if (!inEnvironment) continue;
      final match = RegExp(
        '^\\s+flutter\\s*:\\s*[\\\'\\"]?([^\\\'\\"#]+)',
      ).firstMatch(line);
      if (match != null) return match.group(1)?.trim();
    }
    return null;
  }

  Future<CommandResult?> _tryRun(
    Directory checkout,
    String executable,
    List<String> arguments,
  ) async {
    try {
      return await _runner.run(
        executable,
        arguments,
        workingDirectory: checkout.path,
      );
    } on RepositoryAdapterException {
      return null;
    }
  }
}
