import { pascal } from "case";
import { OpenAPIObject, OperationObject, PathItemObject } from "openapi3-ts";
import ts, { factory as f } from "typescript";

import { getParamsGroupByType } from "./getParamsGroupByType";
import { getRequestBodyType } from "./getRequestBodyType";
import { getResponseType } from "./getResponseType";
import { getVariablesType } from "./getVariablesType";
import { isRequestBodyOptional } from "./isRequestBodyOptional";
import { paramsToSchema } from "./paramsToSchema";
import { schemaToTypeAliasDeclaration } from "./schemaToTypeAliasDeclaration";

export type GetOperationTypesOptions = {
  operationId: string;
  operation: OperationObject;
  openAPIDocument: OpenAPIObject;
  injectedHeaders?: string[];
  pathParameters?: PathItemObject["parameters"];
  printNodes: (nodes: ts.Node[]) => string;
  contextTypeName: string;
  withContextType: boolean;
};

export type GetOperationTypesOutput = {
  dataType: ts.TypeNode;
  errorType: ts.TypeNode;
  requestBodyType: ts.TypeNode;
  pathParamsType: ts.TypeNode;
  variablesType: ts.TypeNode;
  queryParamsType: ts.TypeNode;
  headersType: ts.TypeNode;
  declarationNodes: ts.Node[];
};

/**
 * Get operation types (data, error, params) and associated declaration nodes.
 */
export const getOperationTypes = ({
  operationId,
  operation,
  openAPIDocument,
  printNodes,
  withContextType,
  pathParameters = [],
  injectedHeaders = [],
  contextTypeName,
}: GetOperationTypesOptions): GetOperationTypesOutput => {
  const declarationNodes: ts.Node[] = [];

  // Retrieve dataType
  let dataType = getResponseType({
    responses: operation.responses,
    components: openAPIDocument.components,
    filter: (statusCode) => statusCode.startsWith("2"),
    printNodes,
  });

  // Retrieve errorType
  let errorType = getResponseType({
    responses: operation.responses,
    components: openAPIDocument.components,
    filter: (statusCode) => !statusCode.startsWith("2"),
    printNodes,
  });

  // Retrieve requestBodyType
  let requestBodyType = getRequestBodyType({
    requestBody: operation.requestBody,
    components: openAPIDocument.components,
  });

  // Generate params types
  const { pathParams, queryParams, headerParams } = getParamsGroupByType(
    [...pathParameters, ...(operation.parameters || [])],
    openAPIDocument.components
  );

  // Check if types can be marked as optional (all properties are optional)
  const requestBodyOptional = isRequestBodyOptional({
    requestBody: operation.requestBody,
    components: openAPIDocument.components,
  });
  const headersOptional = headerParams.reduce((mem, p) => {
    if (injectedHeaders.includes(p.name)) return mem;
    return mem && !p.required;
  }, true);
  const pathParamsOptional = pathParams.reduce((mem, p) => {
    return mem && !p.required;
  }, true);
  const queryParamsOptional = queryParams.reduce((mem, p) => {
    return mem && !p.required;
  }, true);

  if (pathParams.length > 0) {
    declarationNodes.push(
      ...schemaToTypeAliasDeclaration(
        `${operationId}PathParams`,
        paramsToSchema(pathParams),
        {
          currentComponent: null,
          openAPIDocument,
        }
      )
    );
  }

  if (queryParams.length > 0) {
    declarationNodes.push(
      ...schemaToTypeAliasDeclaration(
        `${operationId}QueryParams`,
        paramsToSchema(queryParams),
        {
          currentComponent: null,
          openAPIDocument,
        }
      )
    );
  }

  if (headerParams.length > 0) {
    declarationNodes.push(
      ...schemaToTypeAliasDeclaration(
        `${operationId}Headers`,
        paramsToSchema(headerParams, injectedHeaders),
        {
          currentComponent: null,
          openAPIDocument,
        }
      )
    );
  }

  // Export error type if needed
  if (shouldExtractNode(errorType)) {
    const errorTypeIdentifier = pascal(`${operationId}Error`);
    declarationNodes.push(
      f.createTypeAliasDeclaration(
        undefined,
        [f.createModifier(ts.SyntaxKind.ExportKeyword)],
        f.createIdentifier(errorTypeIdentifier),
        undefined,
        errorType
      )
    );

    errorType = f.createTypeReferenceNode(errorTypeIdentifier);
  }

  // Export data type if needed
  if (shouldExtractNode(dataType)) {
    const dataTypeIdentifier = pascal(`${operationId}Response`);
    declarationNodes.push(
      f.createTypeAliasDeclaration(
        undefined,
        [f.createModifier(ts.SyntaxKind.ExportKeyword)],
        f.createIdentifier(dataTypeIdentifier),
        undefined,
        dataType
      )
    );

    dataType = f.createTypeReferenceNode(dataTypeIdentifier);
  }

  // Export requestBody type if needed
  if (shouldExtractNode(requestBodyType)) {
    const requestBodyIdentifier = pascal(`${operationId}RequestBody`);
    declarationNodes.push(
      f.createTypeAliasDeclaration(
        undefined,
        [f.createModifier(ts.SyntaxKind.ExportKeyword)],
        f.createIdentifier(requestBodyIdentifier),
        undefined,
        requestBodyType
      )
    );

    requestBodyType = f.createTypeReferenceNode(requestBodyIdentifier);
  }

  const pathParamsType =
    pathParams.length > 0
      ? f.createTypeReferenceNode(`${pascal(operationId)}PathParams`)
      : f.createTypeLiteralNode([]);

  const queryParamsType =
    queryParams.length > 0
      ? f.createTypeReferenceNode(`${pascal(operationId)}QueryParams`)
      : f.createTypeLiteralNode([]);

  const headersType =
    headerParams.length > 0
      ? f.createTypeReferenceNode(`${pascal(operationId)}Headers`)
      : f.createTypeLiteralNode([]);

  // Generate fetcher variables type
  const variablesIdentifier = pascal(`${operationId}Variables`);

  let variablesType: ts.TypeNode = getVariablesType({
    requestBodyType,
    headersType,
    pathParamsType,
    queryParamsType,
    contextTypeName,
    headersOptional,
    pathParamsOptional,
    queryParamsOptional,
    requestBodyOptional,
    withContextType,
  });

  if (shouldExtractNode(variablesType) || withContextType) {
    declarationNodes.push(
      f.createTypeAliasDeclaration(
        undefined,
        [f.createModifier(ts.SyntaxKind.ExportKeyword)],
        f.createIdentifier(variablesIdentifier),
        undefined,
        variablesType
      )
    );
    variablesType = f.createTypeReferenceNode(variablesIdentifier);
  }

  return {
    dataType,
    errorType,
    declarationNodes,
    headersType,
    pathParamsType,
    queryParamsType,
    requestBodyType,
    variablesType,
  };
};

/**
 * Define if the type should be extracted.
 */
const shouldExtractNode = (node: ts.Node) =>
  ts.isIntersectionTypeNode(node) ||
  (ts.isTypeLiteralNode(node) && node.members.length > 0) ||
  ts.isArrayTypeNode(node);
