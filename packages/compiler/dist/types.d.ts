export type PrimitiveName = 'i8' | 'i16' | 'i32' | 'i64' | 'u8' | 'u16' | 'u32' | 'u64' | 'f32' | 'f64' | 'bool';
export type ResolvedType = PrimitiveRT | PointerRT | IndexedRT | TupleRT | FuncRT | VoidRT | ComptimeIntRT | ComptimeFloatRT | ComptimeListRT | NamedRT;
export interface PrimitiveRT {
    kind: 'primitive';
    name: PrimitiveName;
}
export interface PointerRT {
    kind: 'pointer';
    pointee: ResolvedType;
}
export type IndexSpecifierRT = {
    kind: 'null';
} | {
    kind: 'prefix';
};
export interface IndexedRT {
    kind: 'indexed';
    element: ResolvedType;
    size: number | 'comptime' | null;
    specifiers: IndexSpecifierRT[];
}
export interface TupleRT {
    kind: 'tuple';
    fields: ResolvedField[];
}
export interface FuncRT {
    kind: 'func';
    params: ResolvedField[];
    returns: ResolvedField[];
}
export interface VoidRT {
    kind: 'void';
}
export interface ComptimeIntRT {
    kind: 'comptime_int';
    value: bigint;
}
export interface ComptimeFloatRT {
    kind: 'comptime_float';
    value: number;
}
export interface ComptimeListRT {
    kind: 'comptime_list';
    elements: ResolvedType[];
}
export interface NamedRT {
    kind: 'named';
    name: string;
    type: ResolvedType;
    unique: boolean;
}
export interface ResolvedField {
    name: string | null;
    type: ResolvedType;
}
export declare function primitive(name: PrimitiveName): PrimitiveRT;
export declare function pointer(pointee: ResolvedType): PointerRT;
export declare function indexed(element: ResolvedType, size?: number | 'comptime' | null, specifiers?: IndexSpecifierRT[]): IndexedRT;
export declare function slice(element: ResolvedType): IndexedRT;
export declare function array(element: ResolvedType, size: number): IndexedRT;
export declare function comptimeIndexed(element: ResolvedType): IndexedRT;
export declare function nullterm(element: ResolvedType, size?: number | 'comptime' | null, level?: number): IndexedRT;
export declare function tuple(fields: ResolvedField[]): TupleRT;
export declare function func(params: ResolvedField[], returns: ResolvedField[]): FuncRT;
export declare const VOID: VoidRT;
export declare function comptimeInt(value: bigint): ComptimeIntRT;
export declare function comptimeFloat(value: number): ComptimeFloatRT;
export declare function comptimeList(elements: ResolvedType[]): ComptimeListRT;
export declare function named(name: string, type: ResolvedType, unique: boolean): NamedRT;
export declare function field(name: string | null, type: ResolvedType): ResolvedField;
export declare function defaultIndexedType(t: ResolvedType): IndexedRT | null;
export declare function typeEquals(a: ResolvedType, b: ResolvedType): boolean;
export type Lossiness = 'lossless' | 'lossy';
export type AssignResult = {
    compatible: false;
} | {
    compatible: true;
    lossiness: Lossiness;
    reinterpret: boolean;
};
export declare function typeAssignResult(target: ResolvedType, source: ResolvedType): AssignResult;
export declare function typeAssignable(target: ResolvedType, source: ResolvedType): boolean;
export declare function typeToString(t: ResolvedType, opts?: {
    compact?: boolean;
}): string;
export declare function unwrap(t: ResolvedType): ResolvedType;
export declare function isInteger(t: ResolvedType): boolean;
export declare function isSigned(t: ResolvedType): boolean;
export declare function isUnsigned(t: ResolvedType): boolean;
export declare function isFloat(t: ResolvedType): boolean;
export declare function isNumeric(t: ResolvedType): boolean;
export declare function isBool(t: ResolvedType): boolean;
export declare function isComptime(t: ResolvedType): boolean;
export declare function intBitWidth(t: ResolvedType): number | null;
export declare function primitiveByteSize(t: ResolvedType): number | null;
export declare function isWideningConversion(from: PrimitiveName, to: PrimitiveName): boolean;
export declare function isNarrowingConversion(from: PrimitiveName, to: PrimitiveName): boolean;
export declare function isFloatIntConversion(from: PrimitiveName, to: PrimitiveName): boolean;
export declare function comptimeIntFits(value: bigint, target: PrimitiveRT): boolean;
//# sourceMappingURL=types.d.ts.map