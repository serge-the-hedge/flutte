import 'dart:convert';
import 'dart:io';

import 'package:pub_semver/pub_semver.dart';

import 'command_runner.dart';

/// The fixed Flutter invocation selected before entering a staging worktree.
/// Clean regeneration proves compatibility; automatic maintenance additionally
/// requires an intended SDK and a version satisfying the project constraint.
class ResolvedFlutter {
  const ResolvedFlutter({
    required this.executable,
    required this.argumentsPrefix,
    required this.sdkPath,
    required this.version,
    this.projectConstraint,
    this.source = 'unknown',
  });

  final String executable;
  final List<String> argumentsPrefix;
  final String sdkPath;
  final String version;
  final String? projectConstraint;
  final String source;

  /// Ambient SDKs can prove a clean baseline, but cannot authorize a refresh.
  bool get canRefreshGeneratedOutput => refreshBlockReason == null;

  String? get refreshBlockReason {
    if (source != '--flutter-sdk' && source != 'repository FVM') {
      return 'The selected SDK comes from $source. Automatic refresh requires the repository SDK or an explicit --flutter-sdk selection.';
    }
    final match = RegExp(r'^Flutter (\S+)').firstMatch(version);
    if (match == null)
      return 'The selected Flutter version could not be determined.';
    try {
      final selected = Version.parse(match.group(1)!);
      if (projectConstraint != null &&
          !VersionConstraint.parse(projectConstraint!).allows(selected)) {
        return 'Flutter $selected does not satisfy the project Flutter constraint $projectConstraint; its output cannot be committed as an automatic refresh.';
      }
    } on FormatException {
      return 'The Flutter version or project constraint could not be interpreted; automatic refresh needs a known compatible version.';
    }
    return null;
  }

  String get description {
    final constraint = projectConstraint == null
        ? ''
        : '; project environment.flutter: $projectConstraint (required for automatic refresh)';
    return 'Resolved Flutter SDK: $sdkPath; source: $source; version: $version$constraint';
  }
}

/// Resolves the repository's Flutter toolchain in the order documented by the
/// delivery contract. Repository configuration wins over ambient SDK settings.
/// Resolve the executable once so staging cannot select another FVM version.
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
    if (candidate.source == 'repository FVM') {
      final pinned = await _pinnedVersion(checkout);
      if (pinned != null &&
          RegExp(r'^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$').hasMatch(pinned)) {
        final selected = RegExp(
          r'^Flutter (\S+)',
        ).firstMatch(version)?.group(1);
        if (selected != pinned) {
          throw RepositoryAdapterException(
            'The repository pins Flutter $pinned in .fvmrc, but its SDK reports $version. '
            'From ${checkout.path}, run `fvm use $pinned`, then retry the same delivery command. '
            'No delivery changes were written.',
          );
        }
      }
    }
    return ResolvedFlutter(
      executable: candidate.executable,
      argumentsPrefix: candidate.argumentsPrefix,
      sdkPath: candidate.sdkPath,
      version: version,
      projectConstraint: constraint,
      source: candidate.source,
    );
  }

  Future<ResolvedFlutter> _resolveCandidate(
    Directory checkout,
    String? explicitSdk,
  ) async {
    if (explicitSdk != null && explicitSdk.isNotEmpty) {
      return await _sdkRoot(explicitSdk, '--flutter-sdk', mustExist: true);
    }

    final localSdk = Directory(
      '${checkout.path}${Platform.pathSeparator}.fvm${Platform.pathSeparator}flutter_sdk',
    );
    final localFlutter = File(
      '${localSdk.path}${Platform.pathSeparator}bin${Platform.pathSeparator}flutter',
    );
    if (await localFlutter.exists()) {
      return _sdkRoot(localSdk.path, 'repository FVM', mustExist: true);
    }

    final fvmrc = File('${checkout.path}${Platform.pathSeparator}.fvmrc');
    if (await fvmrc.exists()) {
      if (await _fvmIsAvailable(checkout)) {
        final sdkPath = await _fvmSdkPath(checkout);
        if (sdkPath != null && await File('$sdkPath/bin/flutter').exists()) {
          return _sdkRoot(sdkPath, 'repository FVM', mustExist: true);
        }
      }
      throw RepositoryAdapterException(
        'The repository configures Flutter ${await _pinnedVersion(checkout) ?? '(see .fvmrc)'} in ${fvmrc.path}, but its SDK is not available. '
        'From ${checkout.path}, run `fvm install`, then retry the same delivery command. '
        'If FVM is not installed, install it or select an installed SDK with --flutter-sdk <path>. '
        'Blabla did not fall back to a different Flutter SDK.',
      );
    }

    final flutterRoot = _environment['FLUTTER_ROOT'];
    if (flutterRoot != null && flutterRoot.isNotEmpty) {
      return await _sdkRoot(flutterRoot, 'FLUTTER_ROOT', mustExist: true);
    }

    final onPath = await _tryRun(checkout, 'which', const ['flutter']);
    final path = onPath?.exitCode == 0 && onPath!.stdout.trim().isNotEmpty
        ? onPath.stdout.trim().split('\n').first
        : 'flutter on PATH';
    return ResolvedFlutter(
      executable: path == 'flutter on PATH' ? 'flutter' : path,
      source: 'PATH',
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
      executable: await executable.resolveSymbolicLinks(),
      argumentsPrefix: const [],
      sdkPath: sdk.path,
      source: source,
      version: 'unavailable',
    );
  }

  Future<String?> _pinnedVersion(Directory checkout) async {
    final file = File('${checkout.path}/.fvmrc');
    if (!await file.exists()) return null;
    try {
      final decoded = jsonDecode(await file.readAsString());
      if (decoded is Map<String, dynamic> && decoded['flutter'] is String) {
        return decoded['flutter'] as String;
      }
    } on FormatException {
      // FVM setup guidance remains useful when the config needs repair.
    }
    return null;
  }

  Future<bool> _fvmIsAvailable(Directory checkout) async {
    final result = await _tryRun(checkout, 'fvm', const ['--version']);
    return result?.exitCode == 0;
  }

  Future<String?> _fvmSdkPath(Directory checkout) async {
    final result = await _tryRun(checkout, 'fvm', const ['api', 'project']);
    if (result?.exitCode != 0) return null;
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
      // An unreadable FVM response must not fall back to an ambient SDK.
    }
    return null;
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
