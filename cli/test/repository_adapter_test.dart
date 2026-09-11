import 'dart:convert';
import 'dart:io';

import 'package:blabla_cli/locale_proposal_adapter.dart';
import 'package:blabla_cli/release_delivery_adapter.dart';
import 'package:crypto/crypto.dart';
import 'package:test/test.dart';

void main() {
  for (final deliverRelease in [false, true]) {
    test(
      'refuses a complete new Locale over a changed source catalog in ${deliverRelease ? 'combined' : 'standalone'} delivery',
      () async {
        final fixture = await BrickitFixture.create();
        addTearDown(fixture.dispose);
        if (deliverRelease) await fixture.addGermanCatalog();
        final release = await existingLocaleRelease(fixture);
        final artifact = deliverRelease
            ? await combinedPortugueseArtifact(fixture, release)
            : await portugueseArtifact(fixture);
        await fixture
            .file('packages/brickit_generated/lib/l10n/intl_en.arb')
            .writeAsString('{"@@locale":"en","welcome":"A new meaning"}');
        await fixture.git(['add', '.']);
        await fixture.git(['commit', '-m', 'change source after proposal']);
        final head = await fixture.git(['rev-parse', 'HEAD']);
        await expectLater(
          deliverRelease
              ? ReleaseRepositoryAdapter().deliver(
                  ReleaseDeliveryRequest(
                    checkout: fixture.root,
                    recordId: release.releaseRecord.id,
                    flutter: testFlutter(fixture.flutterExecutable),
                    gateway: StaticReleaseGateway(release),
                    write: (_) {},
                    localeProposal: LocaleProposalDeliveryInput(
                      proposalId: artifact.proposalId,
                      gateway: StaticLocaleProposalGateway(artifact),
                    ),
                  ),
                )
              : RepositoryAdapter().deliver(requestFor(fixture, artifact)),
          throwsA(
            isA<RepositoryAdapterException>().having(
              (error) => error.message,
              'message',
              contains('Source Catalog changed'),
            ),
          ),
        );
        expect(await fixture.git(['rev-parse', 'HEAD']), head);
        expect(await fixture.git(['status', '--porcelain']), isEmpty);
      },
    );

    test(
      'refuses concurrent committed work during ${deliverRelease ? 'release' : 'Portuguese'} delivery',
      () async {
        final fixture = await BrickitFixture.create();
        addTearDown(fixture.dispose);
        final artifact = await portugueseArtifact(fixture);
        if (deliverRelease) await fixture.addGermanCatalog();
        final runner = CountingCommandRunner(
          onFirstGeneration: () async {
            final constants = fixture.file(
              'packages/brickit/lib/constants/locale_const.dart',
            );
            await constants.writeAsString(
              '${await constants.readAsString()}\n// Concurrent runtime registration change\n',
            );
            await fixture.git(['add', constants.path]);
            await fixture.git([
              'commit',
              '-m',
              'concurrent runtime registration',
            ]);
          },
        );
        final delivery = deliverRelease
            ? ReleaseRepositoryAdapter(runner: runner).deliver(
                ReleaseDeliveryRequest(
                  checkout: fixture.root,
                  recordId: 'release_123',
                  flutter: testFlutter(fixture.flutterExecutable),
                  gateway: StaticReleaseGateway(
                    await existingLocaleRelease(fixture),
                  ),
                  write: (_) {},
                ),
              )
            : RepositoryAdapter(
                runner: runner,
              ).deliver(requestFor(fixture, artifact));
        await expectLater(
          delivery,
          throwsA(
            isA<RepositoryAdapterException>().having(
              (error) => error.message,
              'message',
              contains('checkout changed'),
            ),
          ),
        );
        expect(await fixture.git(['branch', '--show-current']), 'develop');
        expect(await fixture.git(['status', '--porcelain']), isEmpty);
        expect(
          await fixture
              .file('packages/brickit/lib/constants/locale_const.dart')
              .readAsString(),
          contains('Concurrent runtime registration change'),
        );
        expect(
          await fixture
              .file('packages/brickit_generated/lib/l10n/intl_pt.arb')
              .exists(),
          isFalse,
        );
      },
    );
  }

  test(
    'refuses a stale Portuguese proposal without changing the checkout',
    () async {
      final fixture = await BrickitFixture.create();
      addTearDown(fixture.dispose);
      final artifact = await portugueseArtifact(fixture);
      final head = await fixture.git(['rev-parse', 'HEAD']);

      await expectLater(
        RepositoryAdapter().deliver(
          requestFor(
            fixture,
            artifact,
            gateway: StaticLocaleProposalGateway(
              artifact,
              deliveryStatus: 'stale',
            ),
          ),
        ),
        throwsA(isA<RepositoryAdapterException>()),
      );

      expect(await fixture.git(['rev-parse', 'HEAD']), head);
      expect(await fixture.git(['branch', '--show-current']), 'develop');
      expect(
        await fixture
            .file('packages/brickit_generated/lib/l10n/intl_pt.arb')
            .exists(),
        isFalse,
      );
    },
  );

  test(
    'rechecks the source snapshot after staging before creating a branch',
    () async {
      final fixture = await BrickitFixture.create();
      addTearDown(fixture.dispose);
      final artifact = await portugueseArtifact(fixture);

      await expectLater(
        RepositoryAdapter().deliver(
          requestFor(
            fixture,
            artifact,
            gateway: SequencedLocaleProposalGateway(
              artifact,
              summaries: [
                LocaleProposalSummary(
                  proposalId: artifact.proposalId,
                  sourceSnapshotId: artifact.sourceSnapshot.id,
                  status: 'ready',
                  deliveryStatus: 'ready',
                ),
                const LocaleProposalSummary(
                  proposalId: 'proposal_pt_123',
                  sourceSnapshotId: 'newer_snapshot',
                  status: 'ready',
                  deliveryStatus: 'ready',
                ),
              ],
            ),
          ),
        ),
        throwsA(isA<RepositoryAdapterException>()),
      );

      expect(await fixture.git(['branch', '--show-current']), 'develop');
      expect(
        await fixture
            .file('packages/brickit_generated/lib/l10n/intl_pt.arb')
            .exists(),
        isFalse,
      );
    },
  );

  test('refuses delivery from a non-integration branch', () async {
    final fixture = await BrickitFixture.create();
    addTearDown(fixture.dispose);
    final artifact = await portugueseArtifact(fixture);
    await fixture.git(['switch', '-c', 'feature/localization']);

    await expectLater(
      RepositoryAdapter().deliver(requestFor(fixture, artifact)),
      throwsA(
        isA<RepositoryAdapterException>().having(
          (error) => error.message,
          'message',
          allOf(contains('feature/localization'), contains('develop')),
        ),
      ),
    );

    expect(
      await fixture.git(['branch', '--show-current']),
      'feature/localization',
    );
    expect(
      await fixture
          .file('packages/brickit_generated/lib/l10n/intl_pt.arb')
          .exists(),
      isFalse,
    );
  });

  test('tells the developer how to fetch a missing source commit', () async {
    final fixture = await BrickitFixture.create();
    addTearDown(fixture.dispose);
    final original = await portugueseArtifact(fixture);
    final artifact = LocaleProposalArtifact(
      version: original.version,
      proposalId: original.proposalId,
      sourceSnapshot: SourceSnapshotIdentity(
        id: original.sourceSnapshot.id,
        repository: original.sourceSnapshot.repository,
        commit: List.filled(40, 'b').join(),
        manifestHash: original.sourceSnapshot.manifestHash,
        catalogPath: original.sourceSnapshot.catalogPath,
      ),
      locale: original.locale,
      catalog: original.catalog,
    );

    await expectLater(
      RepositoryAdapter().deliver(requestFor(fixture, artifact)),
      throwsA(
        isA<RepositoryAdapterException>().having(
          (error) => error.message,
          'message',
          contains('git fetch origin'),
        ),
      ),
    );

    expect(await fixture.git(['branch', '--show-current']), 'develop');
  });

  test('refuses dirty localization files before staging Portuguese', () async {
    final fixture = await BrickitFixture.create();
    addTearDown(fixture.dispose);
    final artifact = await portugueseArtifact(fixture);
    final constants = fixture.file(
      'packages/brickit/lib/constants/locale_const.dart',
    );
    await constants.writeAsString(
      '${await constants.readAsString()}\n// local edit\n',
    );

    await expectLater(
      RepositoryAdapter().deliver(requestFor(fixture, artifact)),
      throwsA(
        isA<RepositoryAdapterException>().having(
          (error) => error.message,
          'message',
          contains('uncommitted localization changes'),
        ),
      ),
    );

    expect(await fixture.git(['branch', '--show-current']), 'develop');
    expect(
      await fixture
          .file('packages/brickit_generated/lib/l10n/intl_pt.arb')
          .exists(),
      isFalse,
    );
  });

  test(
    'refuses a dirty source Catalog Document before staging Portuguese',
    () async {
      final fixture = await BrickitFixture.create();
      addTearDown(fixture.dispose);
      final artifact = await portugueseArtifact(fixture);
      final source = fixture.file(
        'packages/brickit_generated/lib/l10n/intl_en.arb',
      );
      await source.writeAsString('${await source.readAsString()}\n');

      await expectLater(
        RepositoryAdapter().deliver(requestFor(fixture, artifact)),
        throwsA(
          isA<RepositoryAdapterException>().having(
            (error) => error.message,
            'message',
            contains('uncommitted localization changes'),
          ),
        ),
      );

      expect(await fixture.git(['branch', '--show-current']), 'develop');
      expect(
        await fixture
            .file('packages/brickit_generated/lib/l10n/intl_pt.arb')
            .exists(),
        isFalse,
      );
    },
  );

  test(
    'refuses a structurally drifted runtime registration without writing',
    () async {
      final fixture = await BrickitFixture.create();
      addTearDown(fixture.dispose);
      final artifact = await portugueseArtifact(fixture);
      await fixture.commitRuntimeRegistrationDrift();
      final head = await fixture.git(['rev-parse', 'HEAD']);

      await expectLater(
        RepositoryAdapter().deliver(requestFor(fixture, artifact)),
        throwsA(
          isA<RepositoryAdapterException>().having(
            (error) => error.message,
            'message',
            contains('runtime locale registration has drifted'),
          ),
        ),
      );

      expect(await fixture.git(['rev-parse', 'HEAD']), head);
      expect(await fixture.git(['branch', '--show-current']), 'develop');
      expect(
        await fixture
            .file('packages/brickit_generated/lib/l10n/intl_pt.arb')
            .exists(),
        isFalse,
      );
    },
  );

  test('leaves the checkout untouched when Flutter generation fails', () async {
    final fixture = await BrickitFixture.create();
    addTearDown(fixture.dispose);
    final artifact = await portugueseArtifact(fixture);
    final head = await fixture.git(['rev-parse', 'HEAD']);
    final failingFlutter = await fixture.failingFlutter();

    await expectLater(
      RepositoryAdapter().deliver(
        requestFor(fixture, artifact, flutterExecutable: failingFlutter),
      ),
      throwsA(
        isA<RepositoryAdapterException>().having(
          (error) => error.message,
          'message',
          allOf(
            contains('generation failed'),
            contains('Resolved Flutter SDK'),
          ),
        ),
      ),
    );

    expect(await fixture.git(['rev-parse', 'HEAD']), head);
    expect(await fixture.git(['branch', '--show-current']), 'develop');
    expect(
      await fixture
          .file('packages/brickit_generated/lib/l10n/intl_pt.arb')
          .exists(),
      isFalse,
    );
  });

  test('rejects an unexpected generated surface without writing', () async {
    final fixture = await BrickitFixture.create();
    addTearDown(fixture.dispose);
    final artifact = await portugueseArtifact(fixture);
    final unexpectedFlutter = await fixture.unexpectedSurfaceFlutter();

    await expectLater(
      RepositoryAdapter().deliver(
        requestFor(fixture, artifact, flutterExecutable: unexpectedFlutter),
      ),
      throwsA(
        isA<RepositoryAdapterException>().having(
          (error) => error.message,
          'message',
          contains('unexpected surface'),
        ),
      ),
    );

    expect(await fixture.git(['branch', '--show-current']), 'develop');
    expect(
      await fixture
          .file('packages/brickit_generated/lib/l10n/intl_pt.arb')
          .exists(),
      isFalse,
    );
  });

  test(
    'delivers a current Portuguese proposal as one local review branch',
    () async {
      final fixture = await BrickitFixture.create();
      addTearDown(fixture.dispose);

      final catalog = '{"@@locale":"pt","welcome":"Boas-vindas, {name}!"}';
      final artifact = LocaleProposalArtifact(
        version: 1,
        proposalId: 'proposal_pt_123',
        sourceSnapshot: SourceSnapshotIdentity(
          id: 'snapshot_123',
          repository: 'github.com/brickit-app/brickit-flutter',
          commit: fixture.commit,
          manifestHash: List.filled(64, 'a').join(),
          catalogPath: 'packages/brickit_generated/lib/l10n/intl_en.arb',
        ),
        locale: const ProposedLocale(
          code: 'pt',
          label: 'Portuguese',
          runtimeLocale: 'pt-BR',
        ),
        catalog: ProposedCatalog(
          fileName: 'intl_pt.arb',
          content: catalog,
          contentHash: sha256.convert(utf8.encode(catalog)).toString(),
        ),
      );
      final output = StringBuffer();

      final result = await RepositoryAdapter().deliver(
        DeliveryRequest(
          checkout: fixture.root,
          proposalId: artifact.proposalId,
          flutter: testFlutter(fixture.flutterExecutable),
          gateway: StaticLocaleProposalGateway(artifact),
          write: output.writeln,
        ),
      );

      expect(result.branchName, 'blabla/locale-proposal-proposal_pt_123');
      expect(
        result.changedPaths,
        unorderedEquals([
          'packages/brickit_generated/lib/l10n/intl_pt.arb',
          'packages/brickit/lib/constants/locale_const.dart',
          'packages/brickit_generated/lib/l10n/app_localizations.dart',
          'packages/brickit_generated/lib/l10n/app_localizations_pt.dart',
        ]),
      );
      expect(
        await fixture.git(['branch', '--show-current']),
        result.branchName,
      );
      expect(await fixture.git(['status', '--porcelain']), isEmpty);
      final committedPaths = (await fixture.git([
        'diff',
        '--name-only',
        'HEAD^',
        'HEAD',
      ])).split('\n').where((path) => path.isNotEmpty);
      expect(committedPaths, unorderedEquals(result.changedPaths));
      expect(
        await fixture
            .file('packages/brickit_generated/lib/l10n/intl_pt.arb')
            .readAsString(),
        catalog,
      );
      expect(
        await fixture
            .file('packages/brickit/lib/constants/locale_const.dart')
            .readAsString(),
        contains("static const Locale ptLocale = Locale('pt', 'BR');"),
      );
      final generated = await fixture
          .file('packages/brickit_generated/lib/l10n/app_localizations.dart')
          .readAsString();
      expect(generated, contains("case 'pt':"));
      expect(generated, contains('AppLocalizationsPt()'));
      expect(
        fixture
            .file('packages/brickit_generated/lib/l10n/intl_pt_BR.arb')
            .exists(),
        completion(isFalse),
      );
      expect(
        output.toString(),
        allOf(contains('gh pr create'), contains('--base develop')),
      );
    },
  );

  test(
    'delivers reviewed existing-locale values as one local review branch',
    () async {
      final fixture = await BrickitFixture.create();
      addTearDown(fixture.dispose);
      await fixture.addGermanCatalog();
      final summary = await existingLocaleRelease(fixture);
      final baseline = summary.releaseRecord.baselineCommit;
      final output = StringBuffer();

      final result = await ReleaseRepositoryAdapter().deliver(
        ReleaseDeliveryRequest(
          checkout: fixture.root,
          recordId: summary.releaseRecord.id,
          flutter: testFlutter(fixture.flutterExecutable),
          gateway: StaticReleaseGateway(summary),
          write: output.writeln,
        ),
      );

      expect(result.branchName, 'blabla/release-release_123');
      expect(result.applied, ['greeting']);
      expect(result.skipped.single.messageId, 'farewell');
      expect(
        result.changedPaths,
        unorderedEquals([
          'packages/brickit_generated/lib/l10n/intl_de.arb',
          'packages/brickit_generated/lib/l10n/app_localizations_de.dart',
        ]),
      );
      expect(
        await fixture.git(['branch', '--show-current']),
        result.branchName,
      );
      expect(await fixture.git(['status', '--porcelain']), isEmpty);
      expect(
        await fixture
            .file('packages/brickit_generated/lib/l10n/intl_de.arb')
            .readAsString(),
        '{"@@locale":"de","welcome":"Guten Tag"}',
      );
      expect(
        await fixture.git(['show', '-s', '--format=%B', 'HEAD']),
        allOf(
          contains('Blabla-Release-Record: release_123'),
          contains('Blabla-Baseline-Commit: $baseline'),
          contains('Blabla-Applied-Onto: $baseline'),
          contains('Blabla-Applied-Keys: 1'),
          contains('Blabla-Skipped-Keys: 1'),
        ),
      );
      expect(
        await File(result.pullRequestBodyFile).readAsString(),
        allOf(
          contains('Release Record: `release_123`'),
          contains('`farewell` — `source_changed`'),
        ),
      );
      expect(
        output.toString(),
        allOf(
          contains('Applied 1 reviewed key; skipped 1.'),
          contains('Skipped farewell: source_changed.'),
          contains('gh pr create'),
          contains('--body-file'),
        ),
      );
    },
  );

  test(
    'delivers existing fixes and Portuguese in one generated provenance commit',
    () async {
      final fixture = await BrickitFixture.create();
      addTearDown(fixture.dispose);
      await fixture.addGermanCatalog();
      final summary = await existingLocaleRelease(fixture);
      final artifact = await combinedPortugueseArtifact(fixture, summary);
      final output = StringBuffer();
      final runner = CountingCommandRunner();

      final result = await ReleaseRepositoryAdapter(runner: runner).deliver(
        ReleaseDeliveryRequest(
          checkout: fixture.root,
          recordId: summary.releaseRecord.id,
          flutter: testFlutter(fixture.flutterExecutable),
          gateway: StaticReleaseGateway(summary),
          localeProposal: LocaleProposalDeliveryInput(
            proposalId: artifact.proposalId,
            gateway: StaticLocaleProposalGateway(artifact),
          ),
          write: output.writeln,
        ),
      );

      expect(runner.generationCount, 2);
      expect(result.localeProposalId, artifact.proposalId);
      expect(result.branchName, 'blabla/release-release_123');
      expect(
        result.changedPaths,
        unorderedEquals([
          'packages/brickit_generated/lib/l10n/intl_de.arb',
          'packages/brickit_generated/lib/l10n/intl_pt.arb',
          'packages/brickit_generated/lib/l10n/app_localizations.dart',
          'packages/brickit_generated/lib/l10n/app_localizations_de.dart',
          'packages/brickit_generated/lib/l10n/app_localizations_pt.dart',
          'packages/brickit/lib/constants/locale_const.dart',
        ]),
      );
      expect(await fixture.git(['status', '--porcelain']), isEmpty);
      expect(
        await fixture.git(['show', '-s', '--format=%B', 'HEAD']),
        allOf(
          contains('Blabla-Release-Record: release_123'),
          contains('Blabla-Locale-Proposal: proposal_pt_123'),
          contains('Blabla-Locale-Values: 1'),
          contains('Blabla-Source-Snapshot: snapshot_123'),
        ),
      );
      expect(
        await fixture
            .file('packages/brickit_generated/lib/l10n/intl_de.arb')
            .readAsString(),
        '{"@@locale":"de","welcome":"Guten Tag"}',
      );
      expect(
        await fixture
            .file('packages/brickit_generated/lib/l10n/intl_pt.arb')
            .readAsString(),
        artifact.catalog.content,
      );
      expect(
        await File(result.pullRequestBodyFile).readAsString(),
        allOf(
          contains('Release Record: `release_123`'),
          contains('Locale Proposal: `proposal_pt_123`'),
          contains('pt catalog values added: 1'),
          contains('Source Snapshot: `snapshot_123`'),
        ),
      );
      expect(
        output.toString(),
        allOf(
          contains(
            'Applied 1 reviewed key; added pt with 1 catalog value; skipped 1.',
          ),
          contains('git push'),
          contains('gh pr create'),
        ),
      );
    },
  );

  test(
    'delivers a reviewed Source proposal with Portuguese in one branch',
    () async {
      final fixture = await BrickitFixture.create();
      addTearDown(fixture.dispose);
      await fixture.addGermanCatalog();
      final summary = await existingLocaleRelease(fixture);
      final artifact = await combinedPortugueseArtifact(fixture, summary);
      final output = StringBuffer();

      final result = await ReleaseRepositoryAdapter().deliver(
        ReleaseDeliveryRequest(
          checkout: fixture.root,
          recordId: summary.releaseRecord.id,
          flutter: testFlutter(fixture.flutterExecutable),
          gateway: SourceChangingReleaseGateway(summary),
          localeProposal: LocaleProposalDeliveryInput(
            proposalId: artifact.proposalId,
            gateway: StaticLocaleProposalGateway(artifact),
          ),
          write: output.writeln,
        ),
      );

      expect(
        await fixture
            .file('packages/brickit_generated/lib/l10n/intl_en.arb')
            .readAsString(),
        '{"@@locale":"en","welcome":"Welcome back, {name}!"}',
      );
      expect(
        result.changedPaths,
        contains('packages/brickit_generated/lib/l10n/intl_en.arb'),
      );
      expect(result.sourceChanged, isTrue);
      expect(
        await fixture.git(['show', '-s', '--format=%B', 'HEAD']),
        contains('Blabla-Source-Changed: yes'),
      );
      expect(
        await File(result.pullRequestBodyFile).readAsString(),
        contains('Source catalog changed: yes'),
      );
      expect(output.toString(), contains('including reviewed Source changes'));
    },
  );

  test(
    'rejects mismatched combined provenance before changing checkout',
    () async {
      final fixture = await BrickitFixture.create();
      addTearDown(fixture.dispose);
      await fixture.addGermanCatalog();
      final summary = await existingLocaleRelease(fixture);
      final original = await combinedPortugueseArtifact(fixture, summary);
      final artifact = LocaleProposalArtifact(
        version: original.version,
        proposalId: original.proposalId,
        sourceSnapshot: SourceSnapshotIdentity(
          id: 'another_snapshot',
          repository: original.sourceSnapshot.repository,
          commit: original.sourceSnapshot.commit,
          manifestHash: original.sourceSnapshot.manifestHash,
          catalogPath: original.sourceSnapshot.catalogPath,
        ),
        locale: original.locale,
        catalog: original.catalog,
      );
      final head = await fixture.git(['rev-parse', 'HEAD']);

      await expectLater(
        ReleaseRepositoryAdapter().deliver(
          ReleaseDeliveryRequest(
            checkout: fixture.root,
            recordId: summary.releaseRecord.id,
            flutter: testFlutter(fixture.flutterExecutable),
            gateway: StaticReleaseGateway(summary),
            localeProposal: LocaleProposalDeliveryInput(
              proposalId: artifact.proposalId,
              gateway: StaticLocaleProposalGateway(artifact),
            ),
            write: (_) {},
          ),
        ),
        throwsA(
          isA<RepositoryAdapterException>().having(
            (error) => error.message,
            'message',
            contains('do not share'),
          ),
        ),
      );

      expect(await fixture.git(['rev-parse', 'HEAD']), head);
      expect(await fixture.git(['branch', '--show-current']), 'develop');
    },
  );

  test(
    'still delivers Portuguese when every existing key is skipped',
    () async {
      final fixture = await BrickitFixture.create();
      addTearDown(fixture.dispose);
      await fixture.addGermanCatalog();
      final summary = await existingLocaleRelease(fixture);
      final artifact = await combinedPortugueseArtifact(fixture, summary);

      final result = await ReleaseRepositoryAdapter().deliver(
        ReleaseDeliveryRequest(
          checkout: fixture.root,
          recordId: summary.releaseRecord.id,
          flutter: testFlutter(fixture.flutterExecutable),
          gateway: SkippedReleaseGateway(summary),
          localeProposal: LocaleProposalDeliveryInput(
            proposalId: artifact.proposalId,
            gateway: StaticLocaleProposalGateway(artifact),
          ),
          write: (_) {},
        ),
      );

      expect(result.applied, isEmpty);
      expect(result.skipped, hasLength(2));
      expect(
        result.changedPaths,
        unorderedEquals([
          'packages/brickit_generated/lib/l10n/intl_pt.arb',
          'packages/brickit_generated/lib/l10n/app_localizations.dart',
          'packages/brickit_generated/lib/l10n/app_localizations_pt.dart',
          'packages/brickit/lib/constants/locale_const.dart',
        ]),
      );
    },
  );

  test(
    'rejects applied release keys that change no catalog bytes in combined delivery',
    () async {
      final fixture = await BrickitFixture.create();
      addTearDown(fixture.dispose);
      await fixture.addGermanCatalog();
      final summary = await existingLocaleRelease(fixture);
      final artifact = await combinedPortugueseArtifact(fixture, summary);
      final head = await fixture.git(['rev-parse', 'HEAD']);

      await expectLater(
        ReleaseRepositoryAdapter().deliver(
          ReleaseDeliveryRequest(
            checkout: fixture.root,
            recordId: summary.releaseRecord.id,
            flutter: testFlutter(fixture.flutterExecutable),
            gateway: UnchangedAppliedReleaseGateway(summary),
            localeProposal: LocaleProposalDeliveryInput(
              proposalId: artifact.proposalId,
              gateway: StaticLocaleProposalGateway(artifact),
            ),
            write: (_) {},
          ),
        ),
        throwsA(
          isA<RepositoryAdapterException>().having(
            (error) => error.message,
            'message',
            contains('without changing any bound catalog bytes'),
          ),
        ),
      );
      expect(await fixture.git(['rev-parse', 'HEAD']), head);
      expect(await fixture.git(['branch', '--show-current']), 'develop');
    },
  );

  for (final mode in ['existing', 'combined', 'standalone']) {
    test(
      'refreshes committed generated output before $mode delivery',
      () async {
        final fixture = await BrickitFixture.create();
        addTearDown(fixture.dispose);
        await fixture.addGermanCatalog();
        const generated =
            'packages/brickit_generated/lib/l10n/app_localizations_de.dart';
        await fixture.file(generated).writeAsString('stale generated output');
        await fixture.git(['add', '.']);
        await fixture.git(['commit', '-m', 'commit stale generated output']);
        final summary = await existingLocaleRelease(fixture);
        final artifact = await combinedPortugueseArtifact(fixture, summary);
        final head = await fixture.git(['rev-parse', 'HEAD']);
        if (mode == 'existing') {
          await fixture.file('unrelated.txt').writeAsString('keep staged');
          await fixture.git(['add', 'unrelated.txt']);
        }
        if (mode == 'standalone') {
          await RepositoryAdapter().deliver(requestFor(fixture, artifact));
        } else {
          await ReleaseRepositoryAdapter().deliver(
            ReleaseDeliveryRequest(
              checkout: fixture.root,
              recordId: summary.releaseRecord.id,
              flutter: testFlutter(fixture.flutterExecutable),
              gateway: StaticReleaseGateway(summary),
              localeProposal: mode == 'combined'
                  ? LocaleProposalDeliveryInput(
                      proposalId: artifact.proposalId,
                      gateway: StaticLocaleProposalGateway(artifact),
                    )
                  : null,
              write: (_) {},
            ),
          );
        }
        expect(await fixture.git(['rev-list', '--count', '$head..HEAD']), '2');
        expect(
          await fixture.git(['show', 'HEAD~1:$generated']),
          '{"@@locale":"de","welcome":"Hallo"}',
        );
        expect(
          await fixture.git([
            'diff-tree',
            '--no-commit-id',
            '--name-only',
            '-r',
            'HEAD~1',
          ]),
          generated,
        );
        expect(
          await fixture.git(['log', '-1', '--format=%s', 'HEAD~1']),
          'chore(l10n): refresh generated localization',
        );
        expect(
          await fixture.git(['status', '--porcelain']),
          mode == 'existing' ? 'A  unrelated.txt' : isEmpty,
        );
      },
    );
  }

  for (final failure in [
    'interface',
    'unexpected',
    'unstable',
    'sdk',
    'candidate',
  ]) {
    test(
      'keeps checkout untouched on $failure during refresh preparation',
      () async {
        final fixture = await BrickitFixture.create();
        addTearDown(fixture.dispose);
        await fixture.addGermanCatalog();
        const generated =
            'packages/brickit_generated/lib/l10n/app_localizations_de.dart';
        await fixture.file(generated).writeAsString('stale generated output');
        final extra = switch (failure) {
          'interface' =>
            'echo "// changed interface" >> lib/l10n/app_localizations.dart',
          'unexpected' => 'echo unexpected > unexpected.txt',
          'unstable' =>
            r'''
mkdir -p .dart_tool
count=0
if [ -f .dart_tool/count ]; then count=$(cat .dart_tool/count); fi
count=$((count + 1))
echo "$count" > .dart_tool/count
echo "$count" >> lib/l10n/app_localizations_de.dart
''',
          'candidate' =>
            'if [ -f lib/l10n/intl_pt.arb ]; then echo "candidate failed" >&2; exit 1; fi',
          _ => '',
        };
        final wrapper = fixture.file('tools/flutter-preflight');
        await wrapper.writeAsString(
          '#!/bin/sh\nset -eu\n"${fixture.flutterExecutable}" "\$@"\n$extra\n',
        );
        final chmod = await Process.run('chmod', ['+x', wrapper.path]);
        expect(chmod.exitCode, 0);
        await fixture.git(['add', '.']);
        await fixture.git(['commit', '-m', 'prepare generator failure']);
        final head = await fixture.git(['rev-parse', 'HEAD']);
        final summary = await existingLocaleRelease(fixture);
        final artifact = await combinedPortugueseArtifact(fixture, summary);
        final flutter = failure == 'sdk'
            ? ResolvedFlutter(
                executable: wrapper.path,
                argumentsPrefix: [],
                sdkPath: wrapper.path,
                version: 'Flutter 3.44.6',
                source: '--flutter-sdk',
                projectConstraint: '^3.47.0',
              )
            : testFlutter(wrapper.path);
        String? message;
        try {
          await ReleaseRepositoryAdapter().deliver(
            ReleaseDeliveryRequest(
              checkout: fixture.root,
              recordId: summary.releaseRecord.id,
              flutter: flutter,
              gateway: StaticReleaseGateway(summary),
              localeProposal: LocaleProposalDeliveryInput(
                proposalId: artifact.proposalId,
                gateway: StaticLocaleProposalGateway(artifact),
              ),
              write: (_) {},
            ),
          );
          fail('Delivery should stop');
        } on RepositoryAdapterException catch (error) {
          message = error.message;
        }
        expect(
          message,
          contains(switch (failure) {
            'interface' || 'unexpected' => 'unexpected surface',
            'unstable' => 'different output',
            'sdk' => 'project Flutter constraint',
            _ => 'candidate failed',
          }),
        );
        if (failure != 'candidate') {
          final reportPath = RegExp(
            r'Review the differences: (.+)',
          ).firstMatch(message)!.group(1)!;
          final report = await File(reportPath).readAsString();
          expect(report, contains('diff --git'));
          expect(report, contains('stale generated output'));
          expect(message, contains('Next step:'));
        }
        expect(await fixture.git(['rev-parse', 'HEAD']), head);
        expect(await fixture.git(['branch', '--show-current']), 'develop');
        expect(await fixture.git(['status', '--porcelain']), isEmpty);
        expect(
          await fixture.file(generated).readAsString(),
          'stale generated output',
        );
        expect(
          (await fixture.git([
            'worktree',
            'list',
            '--porcelain',
          ])).split('\n').where((line) => line.startsWith('worktree ')),
          hasLength(1),
        );
      },
    );
  }

  test('refuses a tracked symlink before reading a bound catalog', () async {
    final fixture = await BrickitFixture.create();
    addTearDown(fixture.dispose);
    await fixture.addGermanCatalog();
    final outside = await Directory.systemTemp.createTemp('blabla-outside-');
    addTearDown(() => outside.delete(recursive: true));
    final outsideCatalog = File('${outside.path}/intl_de.arb');
    await outsideCatalog.writeAsString('{"@@locale":"de","welcome":"secret"}');
    final german = fixture.file(
      'packages/brickit_generated/lib/l10n/intl_de.arb',
    );
    await german.delete();
    await Link(german.path).create(outsideCatalog.path);
    await fixture.git(['add', '--', german.path]);
    await fixture.git(['commit', '-m', 'track catalog symlink']);
    final summary = await existingLocaleRelease(fixture);

    await expectLater(
      ReleaseRepositoryAdapter().deliver(
        ReleaseDeliveryRequest(
          checkout: fixture.root,
          recordId: summary.releaseRecord.id,
          flutter: testFlutter(fixture.flutterExecutable),
          gateway: StaticReleaseGateway(summary),
          write: (_) {},
        ),
      ),
      throwsA(
        isA<RepositoryAdapterException>().having(
          (error) => error.message,
          'message',
          contains('symlinked localization paths'),
        ),
      ),
    );
    expect(await outsideCatalog.readAsString(), contains('secret'));
  });

  test('rejects a regenerated public-interface signature change', () async {
    final fixture = await BrickitFixture.create();
    addTearDown(fixture.dispose);
    await fixture.addGermanCatalog();
    final summary = await existingLocaleRelease(fixture);
    final flutter = await fixture.signatureChangingFlutter();

    await expectLater(
      ReleaseRepositoryAdapter().deliver(
        ReleaseDeliveryRequest(
          checkout: fixture.root,
          recordId: summary.releaseRecord.id,
          flutter: testFlutter(flutter),
          gateway: StaticReleaseGateway(summary),
          write: (_) {},
        ),
      ),
      throwsA(
        isA<RepositoryAdapterException>().having(
          (error) => error.message,
          'message',
          contains('public localization interface'),
        ),
      ),
    );
    expect(await fixture.git(['branch', '--show-current']), 'develop');
  });

  test('preserves unrelated staged work outside the release commit', () async {
    final fixture = await BrickitFixture.create();
    addTearDown(fixture.dispose);
    await fixture.addGermanCatalog();
    final summary = await existingLocaleRelease(fixture);
    await fixture.file('notes.txt').writeAsString('keep staged');
    await fixture.git(['add', '--', 'notes.txt']);

    await ReleaseRepositoryAdapter().deliver(
      ReleaseDeliveryRequest(
        checkout: fixture.root,
        recordId: summary.releaseRecord.id,
        flutter: testFlutter(fixture.flutterExecutable),
        gateway: StaticReleaseGateway(summary),
        write: (_) {},
      ),
    );

    expect(await fixture.git(['diff', '--cached', '--name-only']), 'notes.txt');
    expect(
      await fixture.git(['show', '--format=', '--name-only', 'HEAD']),
      isNot(contains('notes.txt')),
    );
  });
}

Future<ReleaseSummary> existingLocaleRelease(BrickitFixture fixture) async {
  return ReleaseSummary(
    releaseRecord: ReleaseRecordIdentity(
      id: 'release_123',
      projectId: 'project_123',
      baselineSnapshotId: 'snapshot_123',
      repository: 'github.com/brickit-app/brickit-flutter',
      baselineCommit: await fixture.git(['rev-parse', 'HEAD']),
      manifestHash: List.filled(64, 'a').join(),
      integrationBranch: 'develop',
    ),
    catalogs: const [
      BoundCatalog(
        localeCode: 'en',
        catalogPath: 'packages/brickit_generated/lib/l10n/intl_en.arb',
        isSource: true,
      ),
      BoundCatalog(
        localeCode: 'de',
        catalogPath: 'packages/brickit_generated/lib/l10n/intl_de.arb',
        isSource: false,
      ),
    ],
    changeKeyCount: 2,
  );
}

Future<LocaleProposalArtifact> portugueseArtifact(
  BrickitFixture fixture,
) async {
  const catalog = '{"@@locale":"pt","welcome":"Boas-vindas, {name}!"}';
  return LocaleProposalArtifact(
    version: 1,
    proposalId: 'proposal_pt_123',
    sourceSnapshot: SourceSnapshotIdentity(
      id: 'snapshot_123',
      repository: 'github.com/brickit-app/brickit-flutter',
      commit: fixture.commit,
      manifestHash: List.filled(64, 'a').join(),
      catalogPath: 'packages/brickit_generated/lib/l10n/intl_en.arb',
    ),
    locale: const ProposedLocale(
      code: 'pt',
      label: 'Portuguese',
      runtimeLocale: 'pt-BR',
    ),
    catalog: ProposedCatalog(
      fileName: 'intl_pt.arb',
      content: catalog,
      contentHash: sha256.convert(utf8.encode(catalog)).toString(),
    ),
  );
}

Future<LocaleProposalArtifact> combinedPortugueseArtifact(
  BrickitFixture fixture,
  ReleaseSummary release,
) async {
  final original = await portugueseArtifact(fixture);
  return LocaleProposalArtifact(
    version: original.version,
    proposalId: original.proposalId,
    sourceSnapshot: SourceSnapshotIdentity(
      id: release.releaseRecord.baselineSnapshotId,
      repository: release.releaseRecord.repository,
      commit: release.releaseRecord.baselineCommit,
      manifestHash: release.releaseRecord.manifestHash,
      catalogPath: release.catalogs
          .singleWhere((catalog) => catalog.isSource)
          .catalogPath,
      integrationBranch: release.releaseRecord.integrationBranch,
    ),
    locale: original.locale,
    catalog: original.catalog,
  );
}

DeliveryRequest requestFor(
  BrickitFixture fixture,
  LocaleProposalArtifact artifact, {
  LocaleProposalGateway? gateway,
  String? flutterExecutable,
}) => DeliveryRequest(
  checkout: fixture.root,
  proposalId: artifact.proposalId,
  flutter: testFlutter(flutterExecutable ?? fixture.flutterExecutable),
  gateway: gateway ?? StaticLocaleProposalGateway(artifact),
  write: (_) {},
);

ResolvedFlutter testFlutter(String executable) => ResolvedFlutter(
  executable: executable,
  argumentsPrefix: const [],
  sdkPath: executable,
  version: 'Flutter 3.47.0',
  source: '--flutter-sdk',
);

class StaticLocaleProposalGateway implements LocaleProposalGateway {
  StaticLocaleProposalGateway(
    this.artifact, {
    this.status = 'ready',
    this.deliveryStatus = 'ready',
  });

  final LocaleProposalArtifact artifact;
  final String status;
  final String deliveryStatus;

  @override
  Future<LocaleProposalSummary> readProposal(String proposalId) async =>
      LocaleProposalSummary(
        proposalId: proposalId,
        sourceSnapshotId: artifact.sourceSnapshot.id,
        status: status,
        deliveryStatus: deliveryStatus,
      );

  @override
  Future<LocaleProposalArtifact> readArtifact(String proposalId) async =>
      artifact;
}

class SequencedLocaleProposalGateway implements LocaleProposalGateway {
  SequencedLocaleProposalGateway(this.artifact, {required this.summaries});

  final LocaleProposalArtifact artifact;
  final List<LocaleProposalSummary> summaries;
  var _summaryReadCount = 0;

  @override
  Future<LocaleProposalSummary> readProposal(String proposalId) async {
    final index = _summaryReadCount < summaries.length
        ? _summaryReadCount
        : summaries.length - 1;
    _summaryReadCount += 1;
    return summaries[index];
  }

  @override
  Future<LocaleProposalArtifact> readArtifact(String proposalId) async =>
      artifact;
}

class StaticReleaseGateway implements ReleaseGateway {
  StaticReleaseGateway(this.summary);

  final ReleaseSummary summary;

  @override
  Future<ReleaseSummary> readRelease(String recordId) async => summary;

  @override
  Future<ReleaseDeliveryTree> createDeliveryTree(
    String recordId,
    List<DeliveryTreeFile> files,
  ) async => ReleaseDeliveryTree(
    releaseRecord: summary.releaseRecord,
    files: files
        .map(
          (file) => file.catalogPath.endsWith('intl_de.arb')
              ? const DeliveryTreeFile(
                  catalogPath:
                      'packages/brickit_generated/lib/l10n/intl_de.arb',
                  content: '{"@@locale":"de","welcome":"Guten Tag"}',
                )
              : file,
        )
        .toList(),
    applied: const ['greeting'],
    skipped: const [
      SkippedReleaseKey(messageId: 'farewell', reason: 'source_changed'),
    ],
  );
}

class SkippedReleaseGateway implements ReleaseGateway {
  SkippedReleaseGateway(this.summary);

  final ReleaseSummary summary;

  @override
  Future<ReleaseSummary> readRelease(String recordId) async => summary;

  @override
  Future<ReleaseDeliveryTree> createDeliveryTree(
    String recordId,
    List<DeliveryTreeFile> files,
  ) async => ReleaseDeliveryTree(
    releaseRecord: summary.releaseRecord,
    files: files,
    applied: const [],
    skipped: const [
      SkippedReleaseKey(messageId: 'greeting', reason: 'source_changed'),
      SkippedReleaseKey(messageId: 'farewell', reason: 'missing_source'),
    ],
  );
}

class SourceChangingReleaseGateway implements ReleaseGateway {
  SourceChangingReleaseGateway(this.summary);

  final ReleaseSummary summary;

  @override
  Future<ReleaseSummary> readRelease(String recordId) async => summary;

  @override
  Future<ReleaseDeliveryTree> createDeliveryTree(
    String recordId,
    List<DeliveryTreeFile> files,
  ) async => ReleaseDeliveryTree(
    releaseRecord: summary.releaseRecord,
    files: files
        .map(
          (file) => file.catalogPath.endsWith('intl_en.arb')
              ? const DeliveryTreeFile(
                  catalogPath:
                      'packages/brickit_generated/lib/l10n/intl_en.arb',
                  content:
                      '{"@@locale":"en","welcome":"Welcome back, {name}!"}',
                )
              : file,
        )
        .toList(),
    applied: const ['welcome'],
    skipped: const [],
  );
}

class UnchangedAppliedReleaseGateway implements ReleaseGateway {
  UnchangedAppliedReleaseGateway(this.summary);

  final ReleaseSummary summary;

  @override
  Future<ReleaseSummary> readRelease(String recordId) async => summary;

  @override
  Future<ReleaseDeliveryTree> createDeliveryTree(
    String recordId,
    List<DeliveryTreeFile> files,
  ) async => ReleaseDeliveryTree(
    releaseRecord: summary.releaseRecord,
    files: files,
    applied: const ['greeting'],
    skipped: const [],
  );
}

class CountingCommandRunner implements CommandRunner {
  CountingCommandRunner({this.onFirstGeneration});
  final Future<void> Function()? onFirstGeneration;
  final _delegate = const SystemCommandRunner();
  var generationCount = 0;

  @override
  Future<CommandResult> run(
    String executable,
    List<String> arguments, {
    required String workingDirectory,
    List<int>? stdin,
  }) async {
    if (arguments.contains('gen-l10n')) {
      generationCount += 1;
      if (generationCount == 1) await onFirstGeneration?.call();
    }
    return _delegate.run(
      executable,
      arguments,
      workingDirectory: workingDirectory,
      stdin: stdin,
    );
  }
}

class BrickitFixture {
  BrickitFixture._({
    required this.root,
    required this.commit,
    required this.flutterExecutable,
  });

  final Directory root;
  final String commit;
  final String flutterExecutable;

  static Future<BrickitFixture> create() async {
    final root = await Directory.systemTemp.createTemp(
      'blabla-brickit-fixture-',
    );
    Future<void> write(String path, String contents) async {
      final file = File('${root.path}${Platform.pathSeparator}$path');
      await file.parent.create(recursive: true);
      await file.writeAsString(contents);
    }

    await write('.gitignore', '.dart_tool/\n');
    await write(
      'packages/brickit_generated/l10n.yaml',
      'arb-dir: lib/l10n\ntemplate-arb-file: intl_en.arb\noutput-localization-file: app_localizations.dart\nsynthetic-package: false\n',
    );
    await write(
      'packages/brickit_generated/lib/l10n/intl_en.arb',
      '{"@@locale":"en","welcome":"Welcome, {name}!"}',
    );
    await write(
      'packages/brickit_generated/lib/l10n/app_localizations.dart',
      '''class AppLocalizations {
  static const supportedLocales = <String>['en'];
}

AppLocalizations lookupAppLocalizations(String languageCode) {
  switch (languageCode) {
    case 'en':
      return AppLocalizations();
  }
  throw StateError('unsupported');
}
''',
    );
    await write(
      'packages/brickit/lib/constants/locale_const.dart',
      '''import 'dart:ui';

class BrickitLocaleConstants {
  static const Locale enLocale = Locale('en', 'US');
  static const Locale frLocale = Locale('fr', 'FR');

  static const List<Locale> supportedLocales = [
    enLocale,
    frLocale,
  ];

  static List<String> supportedLanguageCodes = [
    enLocale.languageCode,
    frLocale.languageCode,
  ];
}
''',
    );
    await write('tools/flutter', '''#!/bin/sh
set -eu
if [ "\$1" != "gen-l10n" ]; then
  exit 2
fi
if [ ! -f lib/l10n/intl_pt.arb ]; then
  if [ ! -f lib/l10n/intl_de.arb ]; then
    exit 0
  fi
  cp lib/l10n/intl_de.arb lib/l10n/app_localizations_de.dart
  exit 0
fi
if [ -f lib/l10n/intl_de.arb ]; then
  cp lib/l10n/intl_de.arb lib/l10n/app_localizations_de.dart
fi
cat > lib/l10n/app_localizations.dart <<'EOF'
class AppLocalizations {}

class AppLocalizationsPt extends AppLocalizations {}

bool isSupported(String languageCode) => <String>['en', 'pt'].contains(languageCode);

AppLocalizations lookupAppLocalizations(String languageCode) {
  switch (languageCode) {
    case 'en':
      return AppLocalizations();
    case 'pt':
      return AppLocalizationsPt();
  }
  throw StateError('unsupported');
}
EOF
cat > lib/l10n/app_localizations_pt.dart <<'EOF'
class AppLocalizationsPt {}
EOF
''');
    final flutter = File(
      '${root.path}${Platform.pathSeparator}tools${Platform.pathSeparator}flutter',
    );
    final chmod = await Process.run('chmod', ['+x', flutter.path]);
    if (chmod.exitCode != 0) {
      throw StateError(
        'Could not make fake Flutter executable: ${chmod.stderr}',
      );
    }

    Future<String> git(List<String> args) async {
      final result = await Process.run(
        'git',
        args,
        workingDirectory: root.path,
      );
      if (result.exitCode != 0) {
        throw StateError('git ${args.join(' ')} failed: ${result.stderr}');
      }
      return (result.stdout as String).trim();
    }

    await git(['init']);
    await git(['checkout', '-b', 'develop']);
    await git(['config', 'user.name', 'Blabla test']);
    await git(['config', 'user.email', 'blabla@example.test']);
    await git([
      'remote',
      'add',
      'origin',
      'https://github.com/brickit-app/brickit-flutter.git',
    ]);
    await git(['add', '.']);
    await git(['commit', '-m', 'fixture']);
    return BrickitFixture._(
      root: root,
      commit: await git(['rev-parse', 'HEAD']),
      flutterExecutable: flutter.path,
    );
  }

  File file(String relativePath) =>
      File('${root.path}${Platform.pathSeparator}$relativePath');

  Future<String> git(List<String> args) async {
    final result = await Process.run('git', args, workingDirectory: root.path);
    if (result.exitCode != 0) {
      throw StateError('git ${args.join(' ')} failed: ${result.stderr}');
    }
    return (result.stdout as String).trim();
  }

  Future<void> dispose() => root.delete(recursive: true);

  Future<void> commitRuntimeRegistrationDrift() async {
    final constants = file('packages/brickit/lib/constants/locale_const.dart');
    await constants.writeAsString('''import 'dart:ui';

class BrickitLocaleConstants {
  static const Locale enLocale = Locale('en', 'US');
  static const List<Locale> supportedLocales = [makeLocale()];
  static List<String> supportedLanguageCodes = [enLocale.languageCode];
}
''');
    await git(['add', constants.path]);
    await git(['commit', '-m', 'drift runtime registration']);
  }

  Future<void> addGermanCatalog() async {
    await file(
      'packages/brickit_generated/lib/l10n/intl_de.arb',
    ).writeAsString('{"@@locale":"de","welcome":"Hallo"}');
    final generated = Directory(
      '${root.path}${Platform.pathSeparator}packages${Platform.pathSeparator}brickit_generated',
    );
    final generation = await Process.run(flutterExecutable, [
      'gen-l10n',
    ], workingDirectory: generated.path);
    if (generation.exitCode != 0) {
      throw StateError(
        'Could not generate German fixture: ${generation.stderr}',
      );
    }
    await git(['add', '.']);
    await git(['commit', '-m', 'add German catalog']);
  }

  Future<String> failingFlutter() async {
    final executable = file('tools/flutter-fails-after-candidate');
    await executable.writeAsString('''#!/bin/sh
set -eu
if [ "\$1" != "gen-l10n" ]; then
  exit 2
fi
if [ ! -f lib/l10n/intl_pt.arb ]; then
  exit 0
fi
echo 'generator failed' >&2
exit 1
''');
    final chmod = await Process.run('chmod', ['+x', executable.path]);
    if (chmod.exitCode != 0) {
      throw StateError(
        'Could not make failure Flutter executable: ${chmod.stderr}',
      );
    }
    return executable.path;
  }

  Future<String> unexpectedSurfaceFlutter() async {
    final executable = file('tools/flutter-adds-unexpected-surface');
    await executable.writeAsString('''#!/bin/sh
set -eu
if [ "\$1" != "gen-l10n" ]; then
  exit 2
fi
if [ ! -f lib/l10n/intl_pt.arb ]; then
  exit 0
fi
cat > lib/l10n/app_localizations.dart <<'EOF'
class AppLocalizations {}
class AppLocalizationsPt extends AppLocalizations {}
AppLocalizations lookupAppLocalizations(String languageCode) {
  switch (languageCode) {
    case 'pt':
      return AppLocalizationsPt();
  }
  return AppLocalizations();
}
EOF
cat > lib/l10n/app_localizations_pt.dart <<'EOF'
class AppLocalizationsPt {}
EOF
echo unexpected > lib/l10n/unexpected_generated.dart
''');
    final chmod = await Process.run('chmod', ['+x', executable.path]);
    if (chmod.exitCode != 0) {
      throw StateError(
        'Could not make unexpected-surface Flutter executable: ${chmod.stderr}',
      );
    }
    return executable.path;
  }

  Future<String> signatureChangingFlutter() async {
    final executable = file('tools/flutter-changes-signature');
    await executable.writeAsString('''#!/bin/sh
set -eu
if [ "\$1" != "gen-l10n" ]; then
  exit 2
fi
if grep -q 'Guten Tag' lib/l10n/intl_de.arb; then
  cat > lib/l10n/app_localizations.dart <<'EOF'
class AppLocalizations {
  String get unexpected;
}
EOF
fi
cp lib/l10n/intl_de.arb lib/l10n/app_localizations_de.dart
''');
    final chmod = await Process.run('chmod', ['+x', executable.path]);
    if (chmod.exitCode != 0) {
      throw StateError(
        'Could not make signature-changing Flutter executable: ${chmod.stderr}',
      );
    }
    return executable.path;
  }
}
