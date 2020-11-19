import type { IncomingMessage, ServerResponse } from 'http';

import type {
  // TODO:
  ASTVisitor,
  // gql`` 的返回值？
  DocumentNode,
  ValidationRule,
  ValidationContext,
  ExecutionArgs,
  ExecutionResult,
  FormattedExecutionResult,
  GraphQLSchema,
  GraphQLFieldResolver,
  GraphQLTypeResolver,
  GraphQLFormattedError,
} from 'graphql';

// 内容协商
import accepts from 'accepts';
import httpError from 'http-errors';
import type { HttpError } from 'http-errors';
import {
  Source,
  GraphQLError,
  parse,
  validate,
  execute,
  formatError,
  validateSchema,
  getOperationAST,
  specifiedRules,
} from 'graphql';

import type { GraphiQLOptions, GraphiQLData } from './renderGraphiQL';
import { parseBody } from './parseBody';
import { renderGraphiQL } from './renderGraphiQL';

// `url` is always defined for IncomingMessage coming from http.Server
type Request = IncomingMessage & { url: string };

// TODO: 响应中的json方法是？
type Response = ServerResponse & { json?: (data: unknown) => void };

// 好家伙
type MaybePromise<T> = Promise<T> | T;

/**
 * Used to configure the graphqlHTTP middleware by providing a schema
 * and other configuration options.
 *
 * Options can be provided as an Object, a Promise for an Object, or a Function
 * that returns an Object or a Promise for an Object.
 */

// 选项 / Promise<选项> / 返回选项的函数 / 返回Promise<选项>的函数
export type Options =
  | ((
      request: Request,
      response: Response,
      params?: GraphQLParams,
    ) => MaybePromise<OptionsData>)
  | MaybePromise<OptionsData>;

// 通过schema等选项来配置服务器中间件
// NOTE: express-graphql是以Express服务器中间件的形式接入的 它本身并不是一个独立的服务器
// 因此“服务器中间件指的就是自己”
export interface OptionsData {
  /**
   * A GraphQL schema from graphql-js.
   */
  // 使用buildSchema方法生成的schema，TypeGraphQL的buildSchema同理
  schema: GraphQLSchema;

  /**
   * A value to pass as the context to this middleware.
   */
  // 在resolver组、fieldResolver、typeResolver、extensions中都能获取到
  context?: unknown;

  /**
   * An object to pass as the rootValue to the graphql() function.
   */
  // 和Apollo中的rootValue不同，会被作为resolver链入口的首个resolver的parent参数
  // express-graphql中的rootValue就是resolvers，并且其中的resolver没有parent参数
  // 可以理解为parent是Apollo实现的
  // TODO: graphql()方法是？
  rootValue?: unknown;

  /**
   * A boolean to configure whether the output should be pretty-printed.
   */
  // 是否格式化输出
  pretty?: boolean;

  /**
   * An optional array of validation rules that will be applied on the document
   * in additional to those defined by the GraphQL spec.
   */
  // 自定义schema验证规则
  validationRules?: ReadonlyArray<(ctx: ValidationContext) => ASTVisitor>;

  /**
   * An optional function which will be used to validate instead of default `validate`
   * from `graphql-js`.
   */
  // 自定义验证函数
  customValidateFn?: (
    schema: GraphQLSchema,
    documentAST: DocumentNode,
    rules: ReadonlyArray<ValidationRule>,
  ) => ReadonlyArray<GraphQLError>;

  /**
   * An optional function which will be used to execute instead of default `execute`
   * from `graphql-js`.
   */
  // 重载原生GraphQL的execute方法
  customExecuteFn?: (args: ExecutionArgs) => MaybePromise<ExecutionResult>;

  /**
   * An optional function which will be used to format any errors produced by
   * fulfilling a GraphQL operation. If no function is provided, GraphQL's
   * default spec-compliant `formatError` function will be used.
   */
  // 错误格式化函数
  customFormatErrorFn?: (error: GraphQLError) => GraphQLFormattedError;

  /**
   * An optional function which will be used to create a document instead of
   * the default `parse` from `graphql-js`.
   */
  // 覆盖原生的parse方法来基于DSL创建DocumentNode
  // 知识盲区
  customParseFn?: (source: Source) => DocumentNode;

  /**
   * `formatError` is deprecated and replaced by `customFormatErrorFn`. It will
   *  be removed in version 1.0.0.
   * @deprecated
   */
  formatError?: (error: GraphQLError) => GraphQLFormattedError;

  /**
   * An optional function for adding additional metadata to the GraphQL response
   * as a key-value object. The result will be added to "extensions" field in
   * the resulting JSON. This is often a useful place to add development time
   * info such as the runtime of a query or the amount of resources consumed.
   *
   * Information about the request is provided to be used.
   *
   * This function may be async.
   */
  // 扩展， 没啥要说的， 就是和data同级的字段（extensions）
  extensions?: (
    info: RequestInfo,
  ) => MaybePromise<undefined | { [key: string]: unknown }>;

  /**
   * A boolean to optionally enable GraphiQL mode.
   * Alternatively, instead of `true` you can pass in an options object.
   */
  // 好家伙
  graphiql?: boolean | GraphiQLOptions;

  /**
   * A resolver function to use when one is not provided by the schema.
   * If not provided, the default field resolver is used (which looks for a
   * value or method on the source value with the field's name).
   */
  // 见README中的说明， typeResolver同
  fieldResolver?: GraphQLFieldResolver<unknown, unknown>;

  /**
   * A type resolver function to use when none is provided by the schema.
   * If not provided, the default type resolver is used (which looks for a
   * `__typename` field or alternatively calls the `isTypeOf` method).
   */
  typeResolver?: GraphQLTypeResolver<unknown, unknown>;
}

/**
 * All information about a GraphQL request.
 */
// 原本以为是发起的GraphQL请求的body参数 看起来并不是 那个是GraphQLParams
// 在GraphiQL的实验发现其参数就query（query和mutation都被包裹在这里）和variables
export interface RequestInfo {
  /**
   * The parsed GraphQL document.
   */
  document: DocumentNode;

  /**
   * The variable values used at runtime.
   */
  variables: { readonly [name: string]: unknown } | null;

  /**
   * The (optional) operation name requested.
   */
  operationName: string | null;

  /**
   * The result of executing the operation.
   */
  result: FormattedExecutionResult;

  /**
   * A value to pass as the context to the graphql() function.
   */
  context?: unknown;
}

type Middleware = (request: Request, response: Response) => Promise<void>;

/**
 * Middleware for express; takes an options object or function as input to
 * configure behavior, and returns an express middleware.
 */

// 这个函数返回的就是一个中间件
export function graphqlHTTP(options: Options): Middleware {
  devAssert(options != null, 'GraphQL middleware requires options.');

  return async function graphqlMiddleware(
    // 这个应该是来自于Express中间件队列依次处理的请求和响应
    request: Request,
    response: Response,
  ): Promise<void> {
    // Higher scoped variables are referred to at various stages in the asynchronous state machine below.
    let params: GraphQLParams | undefined;
    let showGraphiQL = false;
    let graphiqlOptions;
    // 默认使用原生
    let formatErrorFn = formatError;
    let pretty = false;
    let result: ExecutionResult;

    try {
      // Parse the Request to get GraphQL request parameters.
      try {
        // TODO: 配置的解析过程
        params = await getGraphQLParams(request);
        // console.log(params);
        // query {
        //   hello
        //  }
        // {
        //   query: 'query {\n hello\n}',
        //   variables: null,
        //   operationName: null,
        //   raw: false
        // }
      } catch (error: unknown) {
        // TODO:
        // When we failed to parse the GraphQL parameters, we still need to get
        // the options object, so make an options call to resolve just that.
        const optionsData = await resolveOptions();
        pretty = optionsData.pretty ?? false;
        formatErrorFn =
          optionsData.customFormatErrorFn ??
          optionsData.formatError ??
          formatErrorFn;
        throw error;
      }

      // Then, resolve the Options to get OptionsData.
      // 解析配置
      const optionsData: OptionsData = await resolveOptions(params);

      // Collect information from the options data object.
      const schema = optionsData.schema;
      const rootValue = optionsData.rootValue;
      const validationRules = optionsData.validationRules ?? [];
      const fieldResolver = optionsData.fieldResolver;
      const typeResolver = optionsData.typeResolver;
      const graphiql = optionsData.graphiql ?? false;
      const extensionsFn = optionsData.extensions;
      const context = optionsData.context ?? request;
      const parseFn = optionsData.customParseFn ?? parse;
      const executeFn = optionsData.customExecuteFn ?? execute;
      const validateFn = optionsData.customValidateFn ?? validate;

      pretty = optionsData.pretty ?? false;
      formatErrorFn =
        optionsData.customFormatErrorFn ??
        optionsData.formatError ??
        formatErrorFn;

      // Assert that schema is required.
      devAssert(
        schema != null,
        'GraphQL middleware options must contain a schema.',
      );

      // GraphQL HTTP only supports GET and POST methods.
      if (request.method !== 'GET' && request.method !== 'POST') {
        throw httpError(405, 'GraphQL only supports GET and POST requests.', {
          headers: { Allow: 'GET, POST' },
        });
      }

      // Get GraphQL params from the request and POST body data.
      const { query, variables, operationName } = params;
      // 需要能展示并且开启了此选项
      showGraphiQL = canDisplayGraphiQL(request, params) && graphiql !== false;
      if (typeof graphiql !== 'boolean') {
        graphiqlOptions = graphiql;
      }

      // If there is no query, but GraphiQL will be displayed, do not produce
      // a result, otherwise return a 400: Bad Request.
      // TODO: 在返回GraphiQL时还会有一个operationName: "IntrospectionQuery"的请求
      // 用于探知所有的元信息来进行渲染DOCS部分
      // 这个还需要再看看
      if (query == null) {
        if (showGraphiQL) {
          return respondWithGraphiQL(response, graphiqlOptions);
        }
        throw httpError(400, 'Must provide query string.');
      }

      // Validate Schema
      const schemaValidationErrors = validateSchema(schema);
      if (schemaValidationErrors.length > 0) {
        // Return 500: Internal Server Error if invalid schema.
        throw httpError(500, 'GraphQL schema validation error.', {
          graphqlErrors: schemaValidationErrors,
        });
      }

      // Parse source to AST, reporting any syntax error.
      let documentAST;
      try {
        // 原生GraphQL的Source方法
        documentAST = parseFn(new Source(query, 'GraphQL request'));
      } catch (syntaxError: unknown) {
        // Return 400: Bad Request if any syntax errors errors exist.
        throw httpError(400, 'GraphQL syntax error.', {
          graphqlErrors: [syntaxError],
        });
      }

      // Validate AST, reporting any errors.
      const validationErrors = validateFn(schema, documentAST, [
        // 内置的规则集
        ...specifiedRules,
        ...validationRules,
      ]);

      if (validationErrors.length > 0) {
        // Return 400: Bad Request if any validation errors exist.
        throw httpError(400, 'GraphQL validation error.', {
          graphqlErrors: validationErrors,
        });
      }

      // Only query operations are allowed on GET requests.
      // GET请求只能走query操作，类似RESTFul规范
      if (request.method === 'GET') {
        // Determine if this GET request will perform a non-query.
        const operationAST = getOperationAST(documentAST, operationName);
        if (operationAST && operationAST.operation !== 'query') {
          // If GraphiQL can be shown, do not perform this query, but
          // provide it to GraphiQL so that the requester may perform it
          // themselves if desired.
          // PUZZLE: 如果此时开启了GraphiQL选项 那么就把内容返回给GraphiQL 供请求者自己执行
          if (showGraphiQL) {
            return respondWithGraphiQL(response, graphiqlOptions, params);
          }

          // Otherwise, report a 405: Method Not Allowed error.
          throw httpError(
            405,
            `Can only perform a ${operationAST.operation} operation from a POST request.`,
            { headers: { Allow: 'POST' } },
          );
        }
      }

      // Perform the execution, reporting any errors creating the context.
      // ！！！执行！
      try {
        result = await executeFn({
          schema,
          document: documentAST,
          rootValue,
          contextValue: context,
          variableValues: variables,
          operationName,
          fieldResolver,
          typeResolver,
        });
      } catch (contextError: unknown) {
        // Return 400: Bad Request if any execution context errors exist.
        throw httpError(400, 'GraphQL execution context error.', {
          graphqlErrors: [contextError],
        });
      }

      // Collect and apply any metadata extensions if a function was provided.
      // https://graphql.github.io/graphql-spec/#sec-Response-Format
      if (extensionsFn) {
        const extensions = await extensionsFn({
          document: documentAST,
          variables,
          operationName,
          result,
          context,
        });

        if (extensions != null) {
          result = { ...result, extensions };
        }
      }
    } catch (rawError: unknown) {
      // If an error was caught, report the httpError status, or 500.
      const error: HttpError = httpError(
        500,
        /* istanbul ignore next: Thrown by underlying library. */
        rawError instanceof Error ? rawError : String(rawError),
      );

      response.statusCode = error.status;

      const { headers } = error;
      if (headers != null) {
        for (const [key, value] of Object.entries(headers)) {
          response.setHeader(key, String(value));
        }
      }

      if (error.graphqlErrors == null) {
        const graphqlError = new GraphQLError(
          error.message,
          undefined,
          undefined,
          undefined,
          undefined,
          error,
        );
        result = { data: undefined, errors: [graphqlError] };
      } else {
        result = { data: undefined, errors: error.graphqlErrors };
      }
    }

    // If no data was included in the result, that indicates a runtime query
    // error, indicate as such with a generic status code.
    // Note: Information about the error itself will still be contained in
    // the resulting JSON payload.
    // https://graphql.github.io/graphql-spec/#sec-Data
    if (response.statusCode === 200 && result.data == null) {
      response.statusCode = 500;
    }

    // Format any encountered errors.
    // 是有可能结果和错误一起返回的，比如部分字段（对象类型）出现错误?
    const formattedResult: FormattedExecutionResult = {
      ...result,
      errors: result.errors?.map(formatErrorFn),
    };

    // If allowed to show GraphiQL, present it instead of JSON.
    if (showGraphiQL) {
      // 意思并不是每次请求都返回带着结果的GraphiQL，而是当本次请求就带着查询参数
      return respondWithGraphiQL(
        response,
        graphiqlOptions,
        params,
        formattedResult,
      );
    }

    // If "pretty" JSON isn't requested, and the server provides a
    // response.json method (express), use that directly.
    // Otherwise use the simplified sendResponse method.
    if (!pretty && typeof response.json === 'function') {
      response.json(formattedResult);
    } else {
      const payload = JSON.stringify(formattedResult, null, pretty ? 2 : 0);
      sendResponse(response, 'application/json', payload);
    }

    // 解析配置
    async function resolveOptions(
      requestParams?: GraphQLParams,
    ): Promise<OptionsData> {
      const optionsResult = await Promise.resolve(
        // 就是一开始传入给这个中间件的options
        typeof options === 'function'
          ? options(request, response, requestParams)
          : options,
      );

      devAssert(
        optionsResult != null && typeof optionsResult === 'object',
        'GraphQL middleware option function must return an options object or a promise which will be resolved to an options object.',
      );

      if (optionsResult.formatError) {
        // eslint-disable-next-line no-console
        console.warn(
          '`formatError` is deprecated and replaced by `customFormatErrorFn`. It will be removed in version 1.0.0.',
        );
      }

      return optionsResult;
    }
  };
}

function respondWithGraphiQL(
  response: Response,
  options?: GraphiQLOptions,
  params?: GraphQLParams,
  result?: FormattedExecutionResult,
): void {
  const data: GraphiQLData = {
    query: params?.query,
    variables: params?.variables,
    operationName: params?.operationName,
    result,
  };
  const payload = renderGraphiQL(data, options);
  return sendResponse(response, 'text/html', payload);
}

// 这个才是查询时携带的
export interface GraphQLParams {
  query: string | null;
  variables: { readonly [name: string]: unknown } | null;
  operationName: string | null;
  raw: boolean;
}

/**
 * Provided a "Request" provided by express or connect (typically a node style
 * HTTPClientRequest), Promise the GraphQL request parameters.
 */
export async function getGraphQLParams(
  request: Request,
): Promise<GraphQLParams> {
  const urlData = new URLSearchParams(request.url.split('?')[1]);
  const bodyData = await parseBody(request);

  // GraphQL Query string.
  let query = urlData.get('query') ?? (bodyData.query as string | null);
  if (typeof query !== 'string') {
    query = null;
  }

  // Parse the variables if needed.
  let variables = (urlData.get('variables') ?? bodyData.variables) as {
    readonly [name: string]: unknown;
  } | null;
  if (typeof variables === 'string') {
    try {
      variables = JSON.parse(variables);
    } catch {
      throw httpError(400, 'Variables are invalid JSON.');
    }
  } else if (typeof variables !== 'object') {
    variables = null;
  }

  // Name of GraphQL operation to execute.
  let operationName =
    urlData.get('operationName') ?? (bodyData.operationName as string | null);
  if (typeof operationName !== 'string') {
    operationName = null;
  }

  const raw = urlData.get('raw') != null || bodyData.raw !== undefined;

  return { query, variables, operationName, raw };
}

/**
 * Helper function to determine if GraphiQL can be displayed.
 */
function canDisplayGraphiQL(request: Request, params: GraphQLParams): boolean {
  // If `raw` false, GraphiQL mode is not enabled.
  // Allowed to show GraphiQL if not requested as raw and this request prefers HTML over JSON.
  // 如果请求的是原生并且请求更期望接收html文件
  // accepts 返回请求接收的内容类型（按照客户端偏好顺序？）
  return !params.raw && accepts(request).types(['json', 'html']) === 'html';
}

/**
 * Helper function for sending a response using only the core Node server APIs.
 */
function sendResponse(response: Response, type: string, data: string): void {
  const chunk = Buffer.from(data, 'utf8');
  response.setHeader('Content-Type', type + '; charset=utf-8');
  response.setHeader('Content-Length', String(chunk.length));
  response.end(chunk);
}

function devAssert(condition: unknown, message: string): asserts condition {
  const booleanCondition = Boolean(condition);
  if (!booleanCondition) {
    throw new Error(message);
  }
}
