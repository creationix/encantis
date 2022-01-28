start = @(_ @toplevel)* _

toplevel
    = export
    / func
    / global
    / memory

export
    = @"export" _ @string _ @exportable

exportable
    = func
    / global

func
    = "func" name:(_ @lowername)? _ args:type out:(_ "->" _ @type)? body:block "end" { return {name,args,out,body} }

global
    = @"global" _ @variable @(_ "=" _ @number)?

variable
    = v:lowername typ:(':' _ @type)? { return typ?{var:v,typ}:{var:v} }

memory
    = @"memory" _ @lowername _ @number

string =
    str:(doublequoted / singlequoted)
    typ:(':' _ @type)? { return typ?{str,typ}:{str} }

escape
    = '\\x' b:([0-9a-fA-F][0-9a-fA-F]) { return String.fromCharCode(parseInt(b.join(""), 16)) }
    / '\\u{' b:[0-9a-fA-F]+ '}' { return String.fromCodePoint(parseInt(b.join(""), 16)) }
    / '\\"' { return '"' }
    / "\\'" { return "'" }
    / "\\\\" { return "\\" }
    / "\\b" { return "\b" }
    / "\\f" { return "\f" }
    / "\\n" { return "\n" }
    / "\\r" { return "\r" }
    / "\\t" { return "\t" }

doublequoted
    = t:('"' @( t:[^"\\\r\n]+ { return t.join('') } / escape)* '"') { return t.join("") }

singlequoted
    = t:("'" @( t:[^'\\\r\n]+ { return t.join('') } / escape)* "'") { return t.join("") }

number = int:integer typ:(':' @type)? { return typ?{int,typ}:{int} }

integer
    = "0" [xX] num:[0-9a-fA-F]+ { return parseInt(num.join(''), 16) }
    / "0" [dD] num:[0-9a-bA-B]+ { return parseInt(num.join(''), 12) }
    / "0" [oO] num:[0-7]+ { return parseInt(num.join(''), 8) }
    / "0" [bB] num:[0-1]+ { return parseInt(num.join(''), 2) }
    / num:[0-9]+  { return parseInt(num.join(''), 10) }

uppername = a:Lu b:(Lu/Ll/[A-Za-z0-9-])* {return a+b.join('')}
lowername = a:Ll b:(Lu/Ll/[A-Za-z0-9-])* {return a+b.join('')}

builtin
    = t:[ui] s:('8' / '16' / '32' / '64') { return t + s }
    / t:'f' s:('32' / '64') { return t + s }

type
    = uppername
	/ builtin
	/ '(' _ @(name:(@lowername _ ':' _)? typ:type (_ ',' _)? { return {name,typ}})* _  ')'
	/ '[' typ:type ']' { return {slice:typ} }
	/ '*' typ:type { return {ptr:typ} }

expression
  = head:Term tail:(_ ("+" / "-") _ Term)*
Term
  = head:Factor tail:(_ ("*" / "/") _ Factor)*
Factor
  = "(" _ @expression _ ")"
// expression =  a:e2 b:(_ ('and' / 'or' / 'xor') _ e2)* { return b.length ? [a,b]:a }
// e2 = (k:'not' _ v:e3 { return [k,v] })+
// e3 = e4 (_ '|' _ e4)*
// e4 = e5 (_ '^' _ e5)*
// e5 = e6 (_ '&' _ e6)*
// e6 = e7 (_ '&' _ e7)*
// e7 = e8 (_ ('<=' / '>=' / '<' / '>') _ e8)*
// e8 = e9 (_ ('<<<' / '>>>' / '<<' / '>>') _ e9)*
// e9 = e10 (_ ('+' / '-') _ e10)*
// e10 = e11 (_ ('*' / '/' / '%') _ e11)*
// e11 = e12 (_ 'as' _ type)?
// e12 = (('-' / '!' / '~') _ e13)+ / e13
// e13 = (e14 (call / index))+ / e14
e14
    = '(' _ expression _ ')'
	/ assignment
	/ ifthenelse
	/ loop
	/ while
	/ for
	/ number (':' _ type)?
	/ func
	/ variable

call
    = '(' _ (expression _ ','? _)* ')'

index
    = '.' lowername / '[' expression ']' / '.*'

target
    = variable index*

assignment
    = target _ ('='
        / '+=' / '-=' / '*=' / '/=' / '%='
        / '<<<=' / '>>>=' / '<<=' / '>>='
        / '&=' / '^='
	) _ expression

ifthenelse =
    'if' expression 'then' block
    ('elif' expression 'then' block)*
    ('else' block)?
    'end'

loop = ('forever' / 'loop' / 'block') block 'end'

while = 'while' expression 'do' block 'end'

for = 'for' target 'in' expression 'do' block 'end'

block
    =  _ @(@statement _ ';'? _)*

statement
    = expression
    / local
    / return when?
    / assignment when

local
    = "local" variable "=" expression

when = ('when' / 'unless') expression

return = ('return' / 'br') expression?


_ = ([ \t\n\r]+ / "--" [^\n]* )* { }

// Letter, Uppercase
Lu = [A-Z]

// Letter, Lowercase
Ll = [a-z]
