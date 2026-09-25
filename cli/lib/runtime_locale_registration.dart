import 'command_runner.dart';

/// The adapter owns this small parser in the consumer app. It preserves script
/// and region for Flutter's locale resolution and round-trips saved BCP-47 tags.
const localeTagParser = r'''
  // Blabla locale tag parser v1: preserve script and region during app startup.
  static Locale localeFromTag(String tag) {
    final match = RegExp(r'^([a-zA-Z]{2,3})(?:-([a-zA-Z]{4}))?(?:-([a-zA-Z]{2}|[0-9]{3}))?$')
        .firstMatch(tag.replaceAll('_', '-'));
    if (match == null) return enLocale;
    final language = match[1]!.toLowerCase();
    if (!supportedLanguageCodes.contains(language)) return enLocale;
    final script = match[2];
    return Locale.fromSubtags(
      languageCode: language,
      scriptCode: script == null ? null : '${script[0].toUpperCase()}${script.substring(1).toLowerCase()}',
      countryCode: match[3]?.toUpperCase(),
    );
  }
''';

String addLocaleTagParser(String source) {
  if (_compact(source).contains(_compact(localeTagParser))) return source;
  if (source.contains('localeFromTag') || !source.trimRight().endsWith('}'))
    throw _drift();
  final offset = source.lastIndexOf('}');
  return source.replaceRange(offset, offset, localeTagParser);
}

const _legacySelection = r'''final String languageCode;
    final String countryCode;

    if (locale.contains('_')) {
      final localeSplit = locale.split('_');
      languageCode = localeSplit[0];
      countryCode = localeSplit[1];
    } else {
      languageCode = locale;
      countryCode = '';
    }

    final isLanguageCodeExist = BrickitLocaleConstants.supportedLanguageCodes
        .contains(languageCode);
    final computedLocale =
        isLanguageCodeExist //
        ? Locale(languageCode, countryCode)
        : BrickitLocaleConstants.enLocale;''';
const _newSelection =
    'final computedLocale = BrickitLocaleConstants.localeFromTag(locale);';
const _legacySavedTag =
    r"'${event.locale.languageCode}_${event.locale.countryCode}'";

/// Upgrade only the known app integration. Unrecognized source requires an
/// explicit integration change, instead of claiming devices can select a variant.
String upgradeLocaleSelection(String source) {
  if (_compact(source).contains(_compact(_newSelection)) &&
      source.contains('event.locale.toLanguageTag()'))
    return source;
  final pattern = RegExp(
    _legacySelection
        .trim()
        .split(RegExp(r'\s+'))
        .map(RegExp.escape)
        .join(r'\s+'),
  );
  if (pattern.allMatches(source).length != 1 ||
      _legacySavedTag.allMatches(source).length != 1) {
    throw RepositoryAdapterException(
      'App locale selection has drifted. Preserve script/region on startup and saved preferences, then verify target-device resolution before delivery.',
    );
  }
  return source
      .replaceFirst(pattern, _newSelection)
      .replaceFirst(_legacySavedTag, 'event.locale.toLanguageTag()');
}

String _compact(String source) => source.replaceAll(RegExp(r'\s+'), '');

/// Edits Brickit's three explicit runtime registration surfaces. Only literal
/// Locale declarations and identifier lists are supported; unfamiliar source
/// shapes fail before the caller writes its checkout.
String addRuntimeLocaleMapping(String source, String runtimeLocale) {
  final requested = _RuntimeLocale.parse(runtimeLocale);
  final inspected = source.replaceAllMapped(
    RegExp(r'/\*[\s\S]*?\*/|//[^\r\n]*'),
    (match) => match[0]!.replaceAll(RegExp(r'[^\r\n]'), ' '),
  );
  final declarationPattern = RegExp(
    r'^[ \t]*static\s+const\s+Locale\s+(\w+)\s*=\s*Locale(\.fromSubtags)?\s*\(([^;]*)\)\s*;',
    multiLine: true,
  );
  final declarations = declarationPattern.allMatches(inspected).toList();
  if (declarations.isEmpty ||
      RegExp(r'\bstatic\s+const\s+Locale\b').allMatches(inspected).length !=
          declarations.length) {
    throw _drift();
  }
  final locales = <String, _RuntimeLocale>{};
  for (final declaration in declarations) {
    final identifier = declaration[1]!;
    if (locales.containsKey(identifier)) throw _drift();
    locales[identifier] = _RuntimeLocale.fromDeclaration(
      declaration[2] != null,
      declaration[3]!,
    );
  }
  final supported = _registrationList(inspected, 'Locale', 'supportedLocales');
  final languageCodes = _registrationList(
    inspected,
    'String',
    'supportedLanguageCodes',
  );
  final supportedNames = _identifiers(supported[1]!, suffix: '');
  final languageNames = _identifiers(
    languageCodes[1]!,
    suffix: '.languageCode',
  );
  if (supportedNames.toSet().length != supportedNames.length ||
      languageNames.toSet().length != languageNames.length ||
      supportedNames.any((name) => !locales.containsKey(name)) ||
      languageNames.any((name) => !supportedNames.contains(name)) ||
      supportedNames.isEmpty ||
      languageNames.isEmpty) {
    throw _drift();
  }
  if (locales.values.any((locale) => locale.tag == requested.tag)) {
    throw RepositoryAdapterException(
      'Brickit already declares ${requested.tag} runtime support. Refusing to add a duplicate Locale.',
    );
  }
  final identifier =
      locales.values.any((locale) => locale.language == requested.language)
      ? '${requested.tag.replaceAll('-', '')}Locale'
      : '${requested.language}Locale';
  if (RegExp('\\b${RegExp.escape(identifier)}\\b').hasMatch(inspected)) {
    throw RepositoryAdapterException(
      'Brickit already uses the runtime identifier $identifier.',
    );
  }
  final additions = <({int offset, String text})>[
    (
      offset: declarations.last.end,
      text: '\n  static const Locale $identifier = ${requested.expression};',
    ),
    _listAddition(supported, identifier),
    if (!languageNames.any(
      (name) => locales[name]!.language == requested.language,
    ))
      _listAddition(languageCodes, '$identifier.languageCode'),
  ]..sort((left, right) => right.offset.compareTo(left.offset));
  var result = source;
  for (final addition in additions) {
    result = result.replaceRange(
      addition.offset,
      addition.offset,
      addition.text,
    );
  }
  return result;
}

RegExpMatch _registrationList(String source, String type, String name) {
  final matches = RegExp(
    '\\bstatic\\s+(?:const\\s+|final\\s+)?List<$type>\\s+$name\\s*=\\s*(?:const\\s*)?\\[([^\\]]*)\\]\\s*;',
  ).allMatches(source).toList();
  if (matches.length != 1) throw _drift();
  return matches.single;
}

List<String> _identifiers(String content, {required String suffix}) {
  final items = content.split(',');
  if (items.last.trim().isEmpty) items.removeLast();
  final expression = RegExp(
    '^([A-Za-z_][A-Za-z0-9_]*)${RegExp.escape(suffix)}\$',
  );
  return items.map((item) {
    final match = expression.firstMatch(item.trim());
    if (match == null) throw _drift();
    return match[1]!;
  }).toList();
}

({int offset, String text}) _listAddition(RegExpMatch list, String value) {
  final declaration = list[0]!;
  final end = list.start + declaration.lastIndexOf(']');
  final content = list[1]!;
  final trailingWhitespace = RegExp(r'\s*$').firstMatch(content)![0]!.length;
  return (
    offset: end - trailingWhitespace,
    text: '${content.trimRight().endsWith(',') ? '' : ','}\n    $value,',
  );
}

RepositoryAdapterException _drift() => RepositoryAdapterException(
  'Brickit runtime locale registration has drifted from the supported adapter shape.',
);

class _RuntimeLocale {
  const _RuntimeLocale(this.language, this.script, this.region);

  final String language;
  final String? script;
  final String? region;

  static _RuntimeLocale parse(String tag) {
    final match = RegExp(
      r'^([a-z]{2,3})(?:-([A-Z][a-z]{3}))?(?:-([A-Z]{2}|[0-9]{3}))?$',
    ).firstMatch(tag);
    if (match == null) {
      throw RepositoryAdapterException('Unsupported runtime Locale: $tag.');
    }
    return _RuntimeLocale(match[1]!, match[2], match[3]);
  }

  static _RuntimeLocale fromDeclaration(bool subtags, String arguments) {
    final values = arguments.split(',').map((value) => value.trim()).toList();
    if (values.last.isEmpty) values.removeLast();
    String literal(String value) {
      final match = RegExp(r'''^(['"])([A-Za-z0-9]+)\1$''').firstMatch(value);
      if (match == null) throw _drift();
      return match[2]!;
    }

    if (!subtags) {
      if (values.isEmpty || values.length > 2) throw _drift();
      return parse(values.map(literal).join('-'));
    }
    final named = <String, String>{};
    for (final value in values) {
      final parts = value.split(':');
      if (parts.length != 2) throw _drift();
      final name = parts.first.trim();
      if (!{'languageCode', 'scriptCode', 'countryCode'}.contains(name) ||
          named.containsKey(name)) {
        throw _drift();
      }
      named[name] = literal(parts.last.trim());
    }
    if (!named.containsKey('languageCode')) throw _drift();
    return parse(
      [
        named['languageCode']!,
        if (named['scriptCode'] != null) named['scriptCode']!,
        if (named['countryCode'] != null) named['countryCode']!,
      ].join('-'),
    );
  }

  String get tag => [language, ?script, ?region].join('-');

  String get expression => script == null
      ? "Locale('$language'${region == null ? '' : ", '$region'"})"
      : "Locale.fromSubtags(languageCode: '$language', scriptCode: '$script'${region == null ? '' : ", countryCode: '$region'"})";
}
