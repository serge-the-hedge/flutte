import 'dart:io';

import 'package:pub_semver/pub_semver.dart';

import 'command_runner.dart';

/// Stamped into every Blabla API request. Release builds may override this with
/// `dart compile exe --define=BLABLA_CLI_VERSION=<release version>`.
const blablaCliVersion = String.fromEnvironment(
  'BLABLA_CLI_VERSION',
  defaultValue: '0.2.1',
);

/// The wire-shape generation understood by this binary. The server may require
/// a later generation without treating a newer output algorithm as policy.
const blablaCliProtocol = 1;

/// One compatibility policy for sync, release, and Locale Proposal requests.
/// Protocol incompatibility blocks; a newer minimum version only advises.
class CliCompatibility {
  final Set<String> _warnedVersions = {};

  void stamp(HttpHeaders headers) {
    headers.set('X-Blabla-CLI-Version', blablaCliVersion);
    headers.set('X-Blabla-CLI-Protocol', '$blablaCliProtocol');
  }

  void check(HttpHeaders headers, {void Function(String)? onWarning}) {
    final requiredProtocol = int.tryParse(
      headers.value('X-Blabla-Minimum-CLI-Protocol') ?? '',
    );
    if (requiredProtocol != null && requiredProtocol > blablaCliProtocol) {
      throw RepositoryAdapterException(
        'Blabla requires CLI protocol $requiredProtocol, but this binary supports $blablaCliProtocol. Install a newer Blabla CLI before retrying.',
      );
    }
    final minimumVersion = headers.value('X-Blabla-Minimum-CLI-Version');
    if (minimumVersion == null) return;
    try {
      if (Version.parse(blablaCliVersion) >= Version.parse(minimumVersion))
        return;
    } on FormatException {
      // Advisory version metadata cannot make a compatible protocol unusable.
      return;
    }
    if (!_warnedVersions.add(minimumVersion)) return;
    onWarning?.call(
      'A newer Blabla CLI ($minimumVersion or newer) is available. This request remains compatible, but update before the next protocol change.',
    );
  }
}
