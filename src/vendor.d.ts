/**
 * Ambient declarations for dependencies that ship no typings.
 *
 * libmime is plain CommonJS with no bundled types. Only the surface this project actually uses is
 * declared here, deliberately: an incomplete but accurate declaration is safer than pulling in a
 * community definition that may drift from the installed version.
 */

declare module 'libmime' {
    interface ParsedHeaderValue {
        value: string;
        params: Record<string, string>;
    }

    interface DecodedHeaderLine {
        key: string;
        value: string;
    }

    const libmime: {
        decodeHeader(headerLine: string): DecodedHeaderLine;
        decodeWords(str: string): string;
        parseHeaderValue(str: string): ParsedHeaderValue;
        decodeFlowed(str: string, delSp?: boolean): string;
        normalizeCharset(charset: string): string;
        foldLines(str: string, lineLength?: number, afterSpace?: boolean): string;
    };

    export = libmime;
}

declare module 'libmime/lib/charset' {
    const charset: {
        decode(buf: Buffer | Uint8Array, fromCharset?: string): string;
        encode(str: string, toCharset?: string): Buffer;
        convert(data: Buffer | string, fromCharset?: string, toCharset?: string): Buffer;
        normalizeCharset(charset: string): string;
    };

    export = charset;
}
