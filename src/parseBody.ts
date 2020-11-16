import type { IncomingMessage } from 'http';
import type { Inflate, Gunzip } from 'zlib';
import zlib from 'zlib';
// 已经变成内置模块了？？ 鬼鬼
import querystring from 'querystring';

// 从stream中获取其完整buffer（以buffer或者string的形式）
import getBody from 'raw-body';
// 用于创建HTTP错误
import httpError from 'http-errors';
// 基于RFC 7231规范创建或读取HTTP Content-Type
import contentType from 'content-type';
import type { ParsedMediaType } from 'content-type';

type Request = IncomingMessage & { body?: unknown };

/**
 * Provided a "Request" provided by express or connect (typically a node style
 * HTTPClientRequest), Promise the body data contained.
 */
export async function parseBody(
  req: Request,
): Promise<{ [param: string]: unknown }> {
  const { body } = req;

  // If express has already parsed a body as a keyed object, use it.
  if (typeof body === 'object' && !(body instanceof Buffer)) {
    return body as { [param: string]: unknown };
  }

  // Skip requests without content types.
  if (req.headers['content-type'] === undefined) {
    return {};
  }

  //  === contentType.parse(req.headers['content-type'])
  // 解析结果包括type与parameters
  const typeInfo = contentType.parse(req);

  // If express has already parsed a body as a string, and the content-type
  // was application/graphql, parse the string body.
  if (typeof body === 'string' && typeInfo.type === 'application/graphql') {
    return { query: body };
  }

  // Already parsed body we didn't recognise? Parse nothing.
  if (body != null) {
    return {};
  }

  // 获取原始body内容
  const rawBody = await readBody(req, typeInfo);
  // Use the correct body parser based on Content-Type header.
  switch (typeInfo.type) {
    // 似乎不是常用的MIME类型
    // apollo-server中并不支持它
    // 官方文档也移除了说明

    // 最终需要解析成对象
    case 'application/graphql':
      return { query: rawBody };
    case 'application/json':
      if (jsonObjRegex.test(rawBody)) {
        try {
          return JSON.parse(rawBody);
        } catch {
          // Do nothing
        }
      }
      // status error properties
      throw httpError(400, 'POST body sent invalid JSON.');
    case 'application/x-www-form-urlencoded':
      // parse(str) foo=bar&abc=xyz&abc=123 ->
      // {
      //   foo: 'bar',
      //   abc: ['xyz', '123']
      // }
      return querystring.parse(rawBody);
  }

  // If no Content-Type header matches, parse nothing.
  return {};
}

/**
 * RegExp to match an Object-opening brace "{" as the first non-space
 * in a string. Allowed whitespace is defined in RFC 7159:
 *
 *     ' '   Space
 *     '\t'  Horizontal tab
 *     '\n'  Line feed or New line
 *     '\r'  Carriage return
 */
const jsonObjRegex = /^[ \t\n\r]*\{/;

// Read and parse a request body.
async function readBody(
  req: Request,
  // {type:"xxx", parameters:"xxx"}
  typeInfo: ParsedMediaType,
): Promise<string> {
  // mime的chartset
  const charset = typeInfo.parameters.charset?.toLowerCase() ?? 'utf-8';

  // Assert charset encoding per JSON RFC 7159 sec 8.1
  if (!charset.startsWith('utf-')) {
    throw httpError(415, `Unsupported charset "${charset.toUpperCase()}".`);
  }

  // Get content-encoding (e.g. gzip)
  // 内容编码格式 gzip deflate identity(没有对实体进行编码) ...
  // 服务器会依据此信息进行解压
  // 服务端返回未压缩的正文时 不允许返回此字段
  const contentEncoding = req.headers['content-encoding'];

  const encoding =
    typeof contentEncoding === 'string'
      ? contentEncoding.toLowerCase()
      : // 这种情况应该是没带上content-enconding头
        'identity';

  // 正文未压缩时直接读取正文长度
  const length = encoding === 'identity' ? req.headers['content-length'] : null;
  const limit = 100 * 1024; // 100kb
  //
  const stream = decompressed(req, encoding);

  // Read body from stream.
  try {
    // charset 默认为utf-8 使用对应的content-encoding解码
    // length 流的长度 目标长度没有达到时会报400错误 默认为null 在编码identity时为content-length的值
    // limit 100kb body的字节数限定 如果body超出这个大小 会报413错误
    return await getBody(stream, { encoding: charset, length, limit });
  } catch (rawError: unknown) {
    // getRawBody过程中出错
    const error = httpError(
      400,
      /* istanbul ignore next: Thrown by underlying library. */
      rawError instanceof Error ? rawError : String(rawError),
    );

    error.message =
      error.type === 'encoding.unsupported'
        ? `Unsupported charset "${charset.toUpperCase()}".`
        : `Invalid body: ${error.message}.`;
    throw error;
  }
}

// Return a decompressed stream, given an encoding.
// 解压流
function decompressed(
  req: Request,
  encoding: string,
): Request | Inflate | Gunzip {
  switch (encoding) {
    case 'identity':
      return req;
    case 'deflate':
      // pipe方法返回接受的值（readable.pipe(writable)）
      return req.pipe(zlib.createInflate());
    case 'gzip':
      return req.pipe(zlib.createGunzip());
  }
  throw httpError(415, `Unsupported content-encoding "${encoding}".`);
}
