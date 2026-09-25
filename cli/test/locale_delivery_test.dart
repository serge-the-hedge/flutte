import 'dart:convert';

import 'package:blabla_cli/locale_proposal_adapter.dart';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';

void main() {
  const delivery = LocaleDelivery();
  test(
    'validates configured language catalogs and explicit runtime mappings',
    () {
      for (final (code, runtime) in [
        ('it', 'it-IT'),
        ('ja', 'ja'),
        ('sr', 'sr-Latn-RS'),
        ('zh-HANT-TW', 'zh-Hant-TW'),
        ('it-IT', 'it-IT'),
      ]) {
        final artifact = _artifact(code: code, runtime: runtime);
        delivery.validateArtifact(artifact, artifact.proposalId);
        expect(
          delivery.expectedChangedPaths(artifact),
          contains('packages/brickit_generated/lib/l10n/intl_$code.arb'),
        );
        expect(
          delivery.generatedLocalePath(artifact),
          endsWith('app_localizations_${code.split('-').first}.dart'),
        );
      }
    },
  );

  test(
    'rejects path escapes, metadata mismatches and incompatible runtime identities',
    () {
      for (final artifact in [
        _artifact(path: 'packages/brickit_generated/lib/l10n/../intl_it.arb'),
        _artifact(path: '/tmp/intl_it.arb'),
        _artifact(path: 'packages/brickit_generated/lib/l10n/intl_en.arb'),
        _artifact(runtime: 'ja-JP'),
        _artifact(runtime: 'it-it'),
        _artifact(code: 'zh-HANT-TW', runtime: 'zh-Hans-TW'),
        _artifact(code: 'zh-HANT-TW', runtime: 'zh-Hant-HK'),
        _artifact(code: 'zh-Hant-TW', runtime: 'zh-Hant-TW'),
        _artifact(metadata: 'ja'),
        _artifact(omitPath: true),
      ]) {
        expect(
          () => delivery.validateArtifact(artifact, artifact.proposalId),
          throwsA(isA<RepositoryAdapterException>()),
        );
      }
    },
  );

  test('retains the legacy Portuguese artifact without a catalog path', () {
    final artifact = _artifact(code: 'pt', runtime: 'pt-BR', omitPath: true);
    delivery.validateArtifact(artifact, artifact.proposalId);
    expect(delivery.catalogPath(artifact), endsWith('/intl_pt.arb'));
  });
}

LocaleProposalArtifact _artifact({
  String code = 'it',
  String runtime = 'it-IT',
  String? path,
  String? metadata,
  bool omitPath = false,
}) {
  final content = jsonEncode({
    '@@locale':
        metadata ??
        ProposedLocale(
          code: code,
          label: 'Example',
          runtimeLocale: runtime,
        ).arbLocale,
    'welcome': 'Welcome',
  });
  return LocaleProposalArtifact(
    version: 1,
    proposalId: 'proposal_123',
    sourceSnapshot: SourceSnapshotIdentity(
      id: 'source_123',
      repository: 'github.com/brickit-app/brickit-flutter',
      commit: 'a' * 40,
      manifestHash: 'b' * 64,
      catalogPath: 'packages/brickit_generated/lib/l10n/intl_en.arb',
    ),
    locale: ProposedLocale(
      code: code,
      label: 'Example language',
      runtimeLocale: runtime,
    ),
    catalog: ProposedCatalog(
      fileName: 'intl_$code.arb',
      catalogPath: omitPath
          ? null
          : path ?? 'packages/brickit_generated/lib/l10n/intl_$code.arb',
      content: content,
      contentHash: sha256.convert(utf8.encode(content)).toString(),
    ),
  );
}
