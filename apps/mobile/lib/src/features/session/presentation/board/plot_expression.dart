import 'dart:math' as math;

/// `plot.fn` の評価器。
///
/// 対応する文法は `packages/contract/src/board.ts` の `plotFunctionPattern` と
/// **同じ範囲**(変数x・数値・四則・累乗・括弧・`sin`/`cos`/`tan`/`sqrt`/`abs`/
/// `log`/`ln`/`exp`/`pi`)。契約側が既にこの範囲へ絞り込んでいるので
/// (「LLMにはパラメータだけ吐かせる」§3-3の関数式版)、ここは自由な数式パーサを
/// 書く必要はなく、その文法だけを相手にすればよい。
///
/// `log` は常用対数(底10)、`ln` は自然対数として扱う(契約のコメントには
/// 明記が無いが、両方を別コマンドとして許可している以上、同じ意味では
/// 使い分ける理由が無いための解釈。高校数学では `log` は底を明示するのが
/// 通例だが、この関数式では底を渡す構文が無いので底10として扱う)。
///
/// 契約・guardrailをすり抜けた入力(手元テストや将来の変更など)は
/// [FormatException] を投げる。呼び出し側([PlotPainter])はここで
/// **アプリを落とさない**責務を持ち、描画をあきらめて代わりの表示にする。
class PlotExpression {
  PlotExpression._(this._root);

  factory PlotExpression.parse(String source) {
    final List<_Token> tokens = _Tokenizer(source).tokenize();
    final _Parser parser = _Parser(tokens);
    final _Node root = parser.parseExpression();
    parser.expectEnd();
    return PlotExpression._(root);
  }

  final _Node _root;

  /// `x` にこの値を入れて評価する。定義域外・0除算等は `double.nan`/`Infinity`
  /// になる(Dartの浮動小数演算はそのまま返すため、ここで特別扱いはしない)。
  /// 呼び出し側は `isFinite` で弾く。
  double evaluate(double x) => _root.evaluate(x);
}

const Set<String> _knownFunctions = <String>{
  'sin', 'cos', 'tan', 'sqrt', 'abs', 'log', 'ln', 'exp',
};

enum _TokenType { number, ident, plus, minus, star, slash, caret, lparen, rparen, comma, end }

class _Token {
  const _Token(this.type, [this.text = '', this.value = 0]);
  final _TokenType type;
  final String text;
  final double value;
}

class _Tokenizer {
  _Tokenizer(this.source);
  final String source;
  int _i = 0;

  List<_Token> tokenize() {
    final List<_Token> tokens = <_Token>[];
    while (true) {
      _skipSpace();
      if (_i >= source.length) {
        tokens.add(const _Token(_TokenType.end));
        break;
      }
      final String c = source[_i];
      if (_isDigit(c) || c == '.') {
        tokens.add(_number());
      } else if (_isAlpha(c)) {
        tokens.add(_ident());
      } else {
        switch (c) {
          case '+':
            tokens.add(const _Token(_TokenType.plus));
          case '-':
            tokens.add(const _Token(_TokenType.minus));
          case '*':
            tokens.add(const _Token(_TokenType.star));
          case '/':
            tokens.add(const _Token(_TokenType.slash));
          case '^':
            tokens.add(const _Token(_TokenType.caret));
          case '(':
            tokens.add(const _Token(_TokenType.lparen));
          case ')':
            tokens.add(const _Token(_TokenType.rparen));
          case ',':
            tokens.add(const _Token(_TokenType.comma));
          default:
            throw FormatException('plotの式に使えない文字です: "$c"', source, _i);
        }
        _i++;
      }
    }
    return tokens;
  }

  void _skipSpace() {
    while (_i < source.length && source[_i].trim().isEmpty) {
      _i++;
    }
  }

  bool _isDigit(String c) => c.codeUnitAt(0) >= 48 && c.codeUnitAt(0) <= 57;
  bool _isAlpha(String c) => RegExp(r'^[a-zA-Z]$').hasMatch(c);

  _Token _number() {
    final int start = _i;
    bool sawDot = false;
    while (_i < source.length && (_isDigit(source[_i]) || (source[_i] == '.' && !sawDot))) {
      if (source[_i] == '.') sawDot = true;
      _i++;
    }
    final String text = source.substring(start, _i);
    return _Token(_TokenType.number, text, double.parse(text));
  }

  _Token _ident() {
    final int start = _i;
    while (_i < source.length && _isAlpha(source[_i])) {
      _i++;
    }
    return _Token(_TokenType.ident, source.substring(start, _i));
  }
}

class _Parser {
  _Parser(this._tokens);
  final List<_Token> _tokens;
  int _pos = 0;

  _Token get _current => _tokens[_pos];

  void expectEnd() {
    if (_current.type != _TokenType.end) {
      throw FormatException('plotの式の末尾に余分な文字があります: "${_current.text}"');
    }
  }

  _Node parseExpression() {
    _Node left = _parseTerm();
    while (_current.type == _TokenType.plus || _current.type == _TokenType.minus) {
      final bool isPlus = _current.type == _TokenType.plus;
      _pos++;
      final _Node right = _parseTerm();
      left = _BinaryNode(isPlus ? (a, b) => a + b : (a, b) => a - b, left, right);
    }
    return left;
  }

  _Node _parseTerm() {
    _Node left = _parseUnary();
    while (_current.type == _TokenType.star || _current.type == _TokenType.slash) {
      final bool isMul = _current.type == _TokenType.star;
      _pos++;
      final _Node right = _parseUnary();
      left = _BinaryNode(isMul ? (a, b) => a * b : (a, b) => a / b, left, right);
    }
    return left;
  }

  _Node _parseUnary() {
    if (_current.type == _TokenType.minus) {
      _pos++;
      final _Node operand = _parseUnary();
      return _UnaryMinusNode(operand);
    }
    return _parsePower();
  }

  _Node _parsePower() {
    final _Node base = _parsePrimary();
    if (_current.type == _TokenType.caret) {
      _pos++;
      // 累乗は右結合(2^3^2 のような入力は稀だが、右から評価する)。
      final _Node exponent = _parseUnary();
      return _BinaryNode((a, b) => math.pow(a, b).toDouble(), base, exponent);
    }
    return base;
  }

  _Node _parsePrimary() {
    final _Token token = _current;
    switch (token.type) {
      case _TokenType.number:
        _pos++;
        return _NumberNode(token.value);
      case _TokenType.lparen:
        _pos++;
        final _Node inner = parseExpression();
        _expect(_TokenType.rparen);
        return inner;
      case _TokenType.ident:
        _pos++;
        return _parseIdent(token.text);
      default:
        throw FormatException('plotの式が不正です(${token.text.isEmpty ? token.type : token.text}の位置)');
    }
  }

  _Node _parseIdent(String name) {
    if (name == 'x') {
      return const _VariableNode();
    }
    if (name == 'pi') {
      return const _NumberNode(math.pi);
    }
    if (_knownFunctions.contains(name)) {
      _expect(_TokenType.lparen);
      final _Node arg = parseExpression();
      _expect(_TokenType.rparen);
      return _FunctionNode(name, arg);
    }
    throw FormatException('plotの式に使えない名前です: "$name"');
  }

  void _expect(_TokenType type) {
    if (_current.type != type) {
      throw FormatException('plotの式が不正です("$type" を期待)');
    }
    _pos++;
  }
}

abstract class _Node {
  double evaluate(double x);
}

class _NumberNode implements _Node {
  const _NumberNode(this.value);
  final double value;
  @override
  double evaluate(double x) => value;
}

class _VariableNode implements _Node {
  const _VariableNode();
  @override
  double evaluate(double x) => x;
}

class _UnaryMinusNode implements _Node {
  const _UnaryMinusNode(this.operand);
  final _Node operand;
  @override
  double evaluate(double x) => -operand.evaluate(x);
}

class _BinaryNode implements _Node {
  const _BinaryNode(this.op, this.left, this.right);
  final double Function(double, double) op;
  final _Node left;
  final _Node right;
  @override
  double evaluate(double x) => op(left.evaluate(x), right.evaluate(x));
}

class _FunctionNode implements _Node {
  const _FunctionNode(this.name, this.arg);
  final String name;
  final _Node arg;

  @override
  double evaluate(double x) {
    final double v = arg.evaluate(x);
    switch (name) {
      case 'sin':
        return math.sin(v);
      case 'cos':
        return math.cos(v);
      case 'tan':
        return math.tan(v);
      case 'sqrt':
        return math.sqrt(v);
      case 'abs':
        return v.abs();
      case 'log':
        return math.log(v) / math.ln10;
      case 'ln':
        return math.log(v);
      case 'exp':
        return math.exp(v);
    }
    throw FormatException('未対応の関数です: "$name"');
  }
}
