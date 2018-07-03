/**
 * Copyright 2017 Google Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as grpc from 'grpc';

import firebase from '@firebase/app';
const SDK_VERSION = firebase.SDK_VERSION;

const grpcVersion = require('grpc/package.json').version;

import { Token } from '../api/credentials';
import { DatabaseInfo } from '../core/database_info';
import { Connection, Stream } from '../remote/connection';
import { StreamBridge } from '../remote/stream_bridge';
import { mapCodeFromRpcCode } from '../remote/rpc_error';
import { assert } from '../util/assert';
import { FirestoreError } from '../util/error';
import * as log from '../util/log';
import { NodeCallback, nodePromise } from '../util/node_api';
import { Deferred } from '../util/promise';

const LOG_TAG = 'Connection';

// TODO(b/38203344): The SDK_VERSION is set independently from Firebase because
// we are doing out-of-band releases. Once we release as part of Firebase, we
// should use the Firebase version instead.
const X_GOOG_API_CLIENT_VALUE = `gl-node/${
  process.versions.node
} fire/${SDK_VERSION} grpc/${grpcVersion}`;

type DuplexRpc<Req, Resp> = () => grpc.ClientDuplexStream<Req, Resp>;
type ReadableRpc<Req, Resp> = (req: Req) => grpc.ClientReadableStream<Resp>;
type UnaryRpc<Req, Resp> = (
  req: Req,
  callback: (err?: grpc.ServiceError, resp?: Resp) => void
) => grpc.ClientUnaryCall;

function createHeaders(databaseInfo: DatabaseInfo, token: Token | null): {} {
  assert(
    token === null || token.type === 'OAuth',
    'If provided, token must be OAuth'
  );

  const channelCredentials = grpc.credentials.createSsl();

  const callCredentials = grpc.credentials.createFromMetadataGenerator(
    (
      context: { service_url: string },
      cb: (error: Error | null, metadata?: grpc.Metadata) => void
    ) => {
      const metadata = new grpc.Metadata();
      if (token) {
        for (const header in token.authHeaders) {
          if (token.authHeaders.hasOwnProperty(header)) {
            metadata.set(header, token.authHeaders[header]);
          }
        }
      }
      metadata.set('x-goog-api-client', X_GOOG_API_CLIENT_VALUE);
      // This header is used to improve routing and project isolation by the
      // backend.
      metadata.set(
        'google-cloud-resource-prefix',
        `projects/${databaseInfo.databaseId.projectId}/` +
          `databases/${databaseInfo.databaseId.database}`
      );
      cb(null, metadata);
    }
  );

  return grpc.credentials.combineChannelCredentials(
    channelCredentials,
    callCredentials
  );
}

// The type of these stubs is dynamically generated by the GRPC runtime
// from the protocol buffer.
// tslint:disable-next-line:no-any
type GeneratedGrpcStub = any;

interface CachedStub {
  stub: GeneratedGrpcStub;
  token: Token | null;
}

/**
 * A Connection implemented by GRPC-Node.
 */
export class GrpcConnection implements Connection {
  // tslint:disable-next-line:no-any
  private firestore: any;

  // We cache stubs for the most-recently-used token.
  private cachedStub: CachedStub | null = null;

  constructor(protos: grpc.GrpcObject, private databaseInfo: DatabaseInfo) {
    this.firestore = protos['google']['firestore']['v1beta1'];
  }

  private sameToken(tokenA: Token | null, tokenB: Token | null): boolean {
    const valueA = tokenA && tokenA.authHeaders['Authorization'];
    const valueB = tokenB && tokenB.authHeaders['Authorization'];
    return valueA === valueB;
  }

  private ensureActiveStub(token: Token | null): GeneratedGrpcStub {
    if (!this.cachedStub || !this.sameToken(this.cachedStub.token, token)) {
      log.debug(LOG_TAG, 'Creating Firestore stub.');
      const credentials = createHeaders(this.databaseInfo, token);
      this.cachedStub = {
        stub: new this.firestore.Firestore(this.databaseInfo.host, credentials),
        token
      };
    }

    return this.cachedStub.stub;
  }

  private getRpcCallable<Req, Resp>(
    rpcName: string,
    token: Token | null
  ): UnaryRpc<Req, Resp> | ReadableRpc<Req, Resp> | DuplexRpc<Req, Resp> {
    // RPC Methods have the first character lower-cased
    // (e.g. Listen => listen(), BatchGetDocuments => batchGetDocuments()).
    const rpcMethod = rpcName.charAt(0).toLowerCase() + rpcName.slice(1);
    const stub = this.ensureActiveStub(token);
    const rpc = stub[rpcMethod];
    assert(rpc != null, 'Unknown RPC: ' + rpcName);
    return rpc.bind(stub);
  }

  invokeRPC<Req, Resp>(
    rpcName: string,
    request: Req,
    token: Token | null
  ): Promise<Resp> {
    const rpc = this.getRpcCallable<Req, Resp>(rpcName, token) as UnaryRpc<
      Req,
      Resp
    >;
    return nodePromise((callback: NodeCallback<Resp>) => {
      log.debug(LOG_TAG, `RPC '${rpcName}' invoked with request:`, request);
      return rpc(
        request,
        (grpcError?: grpc.ServiceError, value?: Resp) => {
          if (grpcError) {
            log.debug(
              LOG_TAG,
              `RPC '${rpcName}' failed with error:`,
              grpcError
            );
            callback(
              new FirestoreError(
                mapCodeFromRpcCode(grpcError.code),
                grpcError.message
              )
            );
          } else {
            log.debug(
              LOG_TAG,
              `RPC '${rpcName}' completed with response:`,
              value
            );
            callback(undefined, value);
          }
        }
      );
    });
  }

  invokeStreamingRPC<Req, Resp>(
    rpcName: string,
    request: Req,
    token: Token | null
  ): Promise<Resp[]> {
    const rpc = this.getRpcCallable(rpcName, token) as ReadableRpc<Req, Resp>;
    const results = [];
    const responseDeferred = new Deferred<Resp[]>();

    log.debug(
      LOG_TAG,
      `RPC '${rpcName}' invoked (streaming) with request:`,
      request
    );
    const stream = rpc(request);
    stream.on('data', response => {
      log.debug(LOG_TAG, `RPC ${rpcName} received result:`, response);
      results.push(response);
    });
    stream.on('end', () => {
      log.debug(LOG_TAG, `RPC '${rpcName}' completed.`);
      responseDeferred.resolve(results);
    });
    stream.on('error', (grpcError: grpc.ServiceError) => {
      log.debug(LOG_TAG, `RPC '${rpcName}' failed with error:`, grpcError);
      const code = mapCodeFromRpcCode(grpcError.code);
      responseDeferred.reject(new FirestoreError(code, grpcError.message));
    });

    return responseDeferred.promise;
  }

  // TODO(mikelehen): This "method" is a monster. Should be refactored.
  openStream<Req, Resp>(
    rpcName: string,
    token: Token | null
  ): Stream<Req, Resp> {
    const rpc = this.getRpcCallable(rpcName, token) as DuplexRpc<Req, Resp>;
    const grpcStream = rpc();

    let closed = false;
    let close: (err?: Error) => void;

    const stream = new StreamBridge<Req, Resp>({
      sendFn: (msg: Req) => {
        if (!closed) {
          log.debug(LOG_TAG, 'GRPC stream sending:', msg);
          try {
            grpcStream.write(msg);
          } catch (e) {
            // This probably means we didn't conform to the proto.  Make sure to
            // log the message we sent.
            log.error('Failure sending:', msg);
            log.error('Error:', e);
            throw e;
          }
        } else {
          log.debug(LOG_TAG, 'Not sending because gRPC stream is closed:', msg);
        }
      },
      closeFn: () => {
        log.debug(LOG_TAG, 'GRPC stream closed locally via close().');
        close();
      }
    });

    close = (err?: FirestoreError) => {
      if (!closed) {
        closed = true;
        stream.callOnClose(err);
        grpcStream.end();
      }
    };

    grpcStream.on('data', (msg: Resp) => {
      if (!closed) {
        log.debug(LOG_TAG, 'GRPC stream received:', msg);
        stream.callOnMessage(msg);
      }
    });

    grpcStream.on('end', () => {
      log.debug(LOG_TAG, 'GRPC stream ended.');
      close();
    });

    grpcStream.on('finish', () => {
      // TODO(mikelehen): I *believe* this assert is safe and we can just remove
      // the 'finish' event if we don't see the assert getting hit for a while.
      assert(closed, 'Received "finish" event without close() being called.');
    });

    grpcStream.on('error', (grpcError: grpc.ServiceError) => {
      log.debug(
        LOG_TAG,
        'GRPC stream error. Code:',
        grpcError.code,
        'Message:',
        grpcError.message
      );
      const code = mapCodeFromRpcCode(grpcError.code);
      close(new FirestoreError(code, grpcError.message));
    });

    grpcStream.on('status', (status: grpc.StatusObject) => {
      // TODO(mikelehen): I *believe* this assert is safe and we can just remove
      // the 'status' event if we don't see the assert getting hit for a while.
      assert(
        closed,
        `status event received before "end" or "error". ` +
          `code: ${status.code} details: ${status.details}`
      );
    });

    log.debug(LOG_TAG, 'Opening GRPC stream');
    // TODO(dimond): Since grpc has no explicit open status (or does it?) we
    // simulate an onOpen in the next loop after the stream had it's listeners
    // registered
    setTimeout(() => {
      stream.callOnOpen();
    }, 0);

    return stream;
  }
}
