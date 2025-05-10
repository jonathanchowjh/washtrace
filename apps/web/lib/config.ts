/**
 * The API reads the environment through the package, so it and the worker
 * service can never disagree about a deployment. This module only keeps the
 * console's imports short.
 */
export { ConfigError, rpcUrls, storeUrl, workerConfig } from '@washtrace/detect';
