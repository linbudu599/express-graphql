// @ts-nocheck
import express from 'express';
import { buildSchema } from 'graphql';

import { graphqlHTTP, OptionsData } from '../src';

const schema = buildSchema(`
    type Query {
      hello(arg: String): String
      outOfField: String
      guess: GuessWhatAmI
      nest: Nested
    }

    type A {
      fieldA: String
    }

    type B {
      fieldB: String
    }

    type Nested {
      field1: String
      field2: String
      field3: NestedAgain
    }

    type NestedAgain {
      field3_1: String
    }

    union GuessWhatAmI = A | B
`);

// The root provides a resolver function for each API endpoint
// 不能区分query mutation这样的操作类型
// apollo中似乎是额外提供的区分
const rootValue = {
  hello: (args, context, info) => {
    // console.log(args);
    // console.log(context);
    // console.log(info);
    return 'Hello GraphQL!';
  },

  guess: () =>
    Math.floor(Math.random() * 10) % 2 === 0
      ? {
          fieldA: 'aaa',
        }
      : {
          fieldB: 'bbb',
        },
  nest: () => ({
    field1: 'NESTED_FIELD_1',
    field2: 'NESTED_FIELD_2',
    field3: {
      field3_1: 'NESTED_AND_NESTED_FILED: 3-1',
    },
  }),
};

const app = express();

const extensions: OptionsData['extensions'] = ({
  document,
  variables,
  operationName,
  result,
  context,
}) => {
  return {
    runningTime: Date.now() - context.startTime,
  };
};

app.use(
  '/graphql',
  graphqlHTTP({
    schema,
    extensions,
    rootValue,
    graphiql: {
      // 默认应用的query
      defaultQuery: undefined,
      // 编辑器头部是否允许编辑
      headerEditorEnabled: true,
    },
    context: {
      connection: 'DATA_BASE_CONNECTION',
      startTime: Date.now(),
    },
    // src: 提供的rootValue值
    fieldResolver: (src, args, context, info) => {
      // console.log(src);
      // console.log(info);
      // console.log('===');
      const isUnionType = ['A', 'B'].includes(info.path.typename);
      const isNestedType = ['Nested', 'NestedAgain'].includes(
        info.path.typename,
      );

      if (info.fieldName in src && !isUnionType && !isNestedType) {
        // console.log('=== common field ===');
        // console.log('resolve value');
        // console.log(src[info.fieldName]());
        return src[info.fieldName]();
      } else if (isUnionType) {
        // 联合类型在fieldResolver中需要返回的也是其类型
        // console.log('=== union type ===');
        // console.log('union type resolve value');
        // console.log(src);
        return info.path.typename;
      } else if (isNestedType) {
        // console.log('=== nested type ===');
        return src[info.fieldName];
      }
      return 'DEFAULT_RESOLVER_RESULT';
    },
    // TODO: 联合类型解析器！！！
    // 解析值 上下文 info 所属的抽象类型 比如Union Type
    typeResolver: (value, ctx, info, absType) => {
      // console.log('type resolver invoked');
      return value.fieldA ? 'A' : 'B';
    },
  }),
);

app.listen(4000);
console.log('Running a GraphQL API server at http://localhost:4000/graphql');
