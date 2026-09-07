import 'package:blabla_cli/command_runner.dart';
import 'package:blabla_cli/runtime_locale_registration.dart';
import 'package:test/test.dart';

const _source = '''import 'dart:ui';
class BrickitLocaleConstants {
  static const Locale enLocale = Locale('en', 'US');
  static const List<Locale> supportedLocales = [enLocale];
  static List<String> supportedLanguageCodes = [enLocale.languageCode];
}
''';

void main() {
  test('repeated additions do not depend on any existing target language', () {
    var source = _source;
    for (final runtime in ['it-IT', 'ja', 'sr-Latn-RS']) {
      source = addRuntimeLocaleMapping(source, runtime);
    }
    expect(source, contains("itLocale = Locale('it', 'IT');"));
    expect(source, contains("jaLocale = Locale('ja');"));
    expect(
      source,
      contains(
        "srLocale = Locale.fromSubtags(languageCode: 'sr', scriptCode: 'Latn', countryCode: 'RS');",
      ),
    );
    expect(source, contains('itLocale.languageCode,'));
    expect(source, contains('jaLocale.languageCode,'));
    expect(source, contains('srLocale.languageCode,'));
    expect(
      () => addRuntimeLocaleMapping(source, 'sr-Latn-RS'),
      throwsA(
        isA<RepositoryAdapterException>().having(
          (error) => error.message,
          'message',
          contains('duplicate'),
        ),
      ),
    );
  });

  test('existing script declarations and quote styles are understood', () {
    final source = _source.replaceFirst(
      "Locale('en', 'US')",
      '''Locale.fromSubtags(
      languageCode: "en",
      countryCode: "US",
    )''',
    );
    expect(
      addRuntimeLocaleMapping(source, 'ja'),
      contains("jaLocale = Locale('ja')"),
    );
    expect(
      () => addRuntimeLocaleMapping(source, 'en-US'),
      throwsA(isA<RepositoryAdapterException>()),
    );
  });

  test('regional mapping shares one language-code registration', () {
    final source = addRuntimeLocaleMapping(_source, 'en-GB');
    expect(source, contains("enGBLocale = Locale('en', 'GB')"));
    expect(source, contains('enGBLocale,'));
    expect(source, isNot(contains('enGBLocale.languageCode')));
  });

  test(
    'rejects unsupported registration expressions and duplicate declarations',
    () {
      for (final source in [
        _source.replaceFirst('[enLocale]', '[...localeFactory()]'),
        _source.replaceFirst('[enLocale]', '[missingLocale]'),
        _source.replaceFirst('[enLocale]', '[enLocale, enLocale]'),
        _source.replaceFirst('supportedLocales', 'activeLocales'),
        _source.replaceFirst("Locale('en', 'US')", "Locale(language, 'US')"),
        '/* $_source */',
      ]) {
        expect(
          () => addRuntimeLocaleMapping(source, 'it-IT'),
          throwsA(isA<RepositoryAdapterException>()),
        );
      }
    },
  );

  test('rejects malformed runtime tags before generating Dart source', () {
    for (final runtime in [
      'IT',
      'it_it',
      'it-it',
      'sr-LATN',
      "it'); exit(0)",
      'en-US-extra',
    ]) {
      expect(
        () => addRuntimeLocaleMapping(_source, runtime),
        throwsA(isA<RepositoryAdapterException>()),
      );
    }
  });
}
