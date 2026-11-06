/**
 * Validation for the small, dependency-free config objects the ECC rows take.
 *
 * The Loader passes the row's raw YAML `config`; these helpers keep every
 * entry honest about types and give the user a precise load-time error instead
 * of a silent no-op later.
 */

import path from 'node:path';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(config, key, fallback) {
  const value = config[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'string') {
    throw new Error(`ECC config: "${key}" must be a string`);
  }
  return value;
}

function booleanField(config, key, fallback) {
  const value = config[key];
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    throw new Error(`ECC config: "${key}" must be a boolean`);
  }
  return value;
}

function integerField(config, key, fallback, min, max) {
  const value = config[key];
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`ECC config: "${key}" must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function resolveConfig(raw, defaults) {
  const config = isPlainObject(raw) ? raw : {};
  const eccRoot = path.resolve(stringField(config, 'eccRoot', defaults.eccRoot));

  return Object.freeze({
    enabled: booleanField(config, 'enabled', defaults.enabled ?? true),
    eccRoot,
    logWarnings: booleanField(config, 'logWarnings', defaults.logWarnings ?? true),
  });
}

export function resolveCommandsConfig(raw, defaults) {
  const base = resolveConfig(raw, defaults);
  const config = isPlainObject(raw) ? raw : {};

  return Object.freeze({
    ...base,
    commandsDir: path.resolve(
      base.eccRoot,
      stringField(config, 'commandsDir', defaults.commandsDir ?? 'commands')
    ),
    includeDoctor: booleanField(config, 'includeDoctor', defaults.includeDoctor ?? true),
    includeAliases: booleanField(config, 'includeAliases', defaults.includeAliases ?? true),
    descriptionMaxLength: integerField(
      config,
      'descriptionMaxLength',
      defaults.descriptionMaxLength ?? 300,
      40,
      2000
    ),
  });
}

export function resolveSkillsConfig(raw, defaults) {
  const base = resolveConfig(raw, defaults);
  const config = isPlainObject(raw) ? raw : {};

  return Object.freeze({
    ...base,
    skillsDir: path.resolve(
      base.eccRoot,
      stringField(config, 'skillsDir', defaults.skillsDir ?? 'skills')
    ),
    cacheTtlMs: integerField(config, 'cacheTtlMs', defaults.cacheTtlMs ?? 5000, 0, 300000),
  });
}

export function resolveAgentsConfig(raw, defaults) {
  const base = resolveConfig(raw, defaults);
  const config = isPlainObject(raw) ? raw : {};
  const provider = stringField(config, 'provider', defaults.provider ?? 'spawn');

  if (provider.trim() === '') {
    throw new Error('ECC config: "provider" must be non-empty');
  }

  return Object.freeze({
    ...base,
    agentsDir: path.resolve(
      base.eccRoot,
      stringField(config, 'agentsDir', defaults.agentsDir ?? 'agents')
    ),
    provider,
    descriptionMaxLength: integerField(
      config,
      'descriptionMaxLength',
      defaults.descriptionMaxLength ?? 5000,
      500,
      20000
    ),
  });
}

export function resolveHooksConfig(raw, defaults) {
  const base = resolveConfig(raw, defaults);
  const config = isPlainObject(raw) ? raw : {};

  return Object.freeze({
    ...base,
    hooksPath: path.resolve(
      base.eccRoot,
      stringField(config, 'hooksPath', defaults.hooksPath ?? 'hooks/hooks.json')
    ),
    profile: stringField(config, 'profile', defaults.profile ?? ''),
    timeoutSeconds: integerField(
      config,
      'timeoutSeconds',
      defaults.timeoutSeconds ?? 0,
      0,
      3600
    ),
    maxTimeoutSeconds: integerField(
      config,
      'maxTimeoutSeconds',
      defaults.maxTimeoutSeconds ?? 600,
      1,
      3600
    ),
    asyncHooks: booleanField(config, 'asyncHooks', defaults.asyncHooks ?? true),
    injectContext: booleanField(config, 'injectContext', defaults.injectContext ?? true),
    maxStopBlocks: integerField(
      config,
      'maxStopBlocks',
      defaults.maxStopBlocks ?? 3,
      0,
      10
    ),
    stopBlockingTimeoutSeconds: integerField(
      config,
      'stopBlockingTimeoutSeconds',
      defaults.stopBlockingTimeoutSeconds ?? 30,
      1,
      300
    ),
    maxInputBytes: integerField(
      config,
      'maxInputBytes',
      defaults.maxInputBytes ?? 1048576,
      65536,
      16777216
    ),
    maxOutputBytes: integerField(
      config,
      'maxOutputBytes',
      defaults.maxOutputBytes ?? 2097152,
      65536,
      16777216
    ),
  });
}
