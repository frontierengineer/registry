// "Everything published stays" (the Application Interface, rule 7): a Release
// may only add to what the Release listed before it published. Anything a
// caller reaches by id, and every field a caller fills in, is published:
// removing one, renaming it (a removal beside an addition) or changing its
// type breaks a caller, and so does a field that a caller could leave out
// before and now must fill in.

import { isObject } from './contributions.mjs';

const PLURAL = [
  ['surface', 'actions', 'action'],
  ['surface', 'optionSources', 'option source'],
  ['surface', 'modals', 'modal'],
  ['surface', 'badges', 'badge'],
  ['host', 'methods', 'method'],
  ['worker', 'workloads', 'workload'],
];

const SINGULAR = [
  ['surface', 'desktop', 'desktop'],
  ['surface', 'panel', 'panel'],
  ['surface', 'display', 'display'],
  ['surface', 'configuration', 'configuration view'],
  ['host', 'notifier', 'notifier'],
  ['host', 'setupCheck', 'setup check'],
  ['worker', 'runtime', 'runtime'],
  ['worker', 'workspaceProvisioner', 'workspace provisioner'],
  ['worker', 'daemon', 'daemon'],
];

const sectionOf = (contributions, name) => (isObject(contributions?.[name]) ? contributions[name] : {});
const listOf = (value) => (Array.isArray(value) ? value : []);
const byId = (entries) => new Map(listOf(entries).filter((entry) => isObject(entry) && typeof entry.id === 'string').map((entry) => [entry.id, entry]));
const byKey = (fields) => new Map(listOf(fields).filter((field) => isObject(field) && typeof field.key === 'string').map((field) => [field.key, field]));

/** What a later field list breaks of an earlier one, each in words. */
function fieldBreaks(where, before, after) {
  const broken = [];
  const old = byKey(before);
  const now = byKey(after);
  for (const [key, field] of old) {
    const kept = now.get(key);
    if (kept === undefined) { broken.push(`${where} removes the field "${key}"`); continue; }
    if (kept.type !== field.type) broken.push(`${where} changes the field "${key}" from ${field.type} to ${kept.type}`);
    if (kept.required === true && field.required !== true) broken.push(`${where} makes the field "${key}" required`);
  }
  for (const [key, field] of now) {
    if (!old.has(key) && field.required === true) broken.push(`${where} adds the required field "${key}"`);
  }
  return broken;
}

/** What a later output field list breaks of an earlier one: a caller reads
 *  every field, so one removed, retyped or no longer always there breaks it. */
function outputBreaks(where, before, after) {
  const broken = [];
  const now = byKey(after);
  for (const [key, field] of byKey(before)) {
    const kept = now.get(key);
    if (kept === undefined) { broken.push(`${where} no longer answers the field "${key}"`); continue; }
    if (kept.type !== field.type) broken.push(`${where} changes the answered field "${key}" from ${field.type} to ${kept.type}`);
    if (field.required === true && kept.required !== true) broken.push(`${where} no longer always answers the field "${key}"`);
  }
  return broken;
}

/** Every way `after` breaks a caller of `before`, in words; empty when it
 *  only adds. */
export function breakingChanges(before, after) {
  const broken = [];
  if (typeof before.aliasOf === 'string' && before.aliasOf !== '' && after.aliasOf !== before.aliasOf) {
    broken.push(`it stood in for ${before.aliasOf} and no longer does`);
  }
  for (const [section, name, word] of SINGULAR) {
    if (sectionOf(before, section)[name] !== undefined && sectionOf(after, section)[name] === undefined) broken.push(`it removes its ${word}`);
  }
  for (const [section, name, word] of PLURAL) {
    const old = byId(sectionOf(before, section)[name]);
    const now = byId(sectionOf(after, section)[name]);
    for (const [id, entry] of old) {
      const kept = now.get(id);
      if (kept === undefined) { broken.push(`it removes the ${word} "${id}"`); continue; }
      if (name === 'actions') broken.push(...fieldBreaks(`the action "${id}"`, entry.input, kept.input));
      if (name === 'methods' || name === 'workloads') {
        // The Application Interface declares no types for either today; a
        // Contributions File that declares fields for them is held to them.
        broken.push(...fieldBreaks(`the ${word} "${id}"`, entry.input, kept.input));
        broken.push(...outputBreaks(`the ${word} "${id}"`, entry.output, kept.output));
      }
      if (name === 'badges' && entry.actionId !== kept.actionId) broken.push(`the badge "${id}" runs "${kept.actionId}" in place of "${entry.actionId}"`);
    }
  }
  const runtimeBefore = sectionOf(before, 'worker').runtime;
  const runtimeAfter = sectionOf(after, 'worker').runtime;
  if (isObject(runtimeBefore) && isObject(runtimeAfter)) broken.push(...fieldBreaks('its runtime', runtimeBefore.options, runtimeAfter.options));
  const provisionerBefore = sectionOf(before, 'worker').workspaceProvisioner;
  const provisionerAfter = sectionOf(after, 'worker').workspaceProvisioner;
  if (isObject(provisionerBefore) && isObject(provisionerAfter)) broken.push(...fieldBreaks('its workspace provisioner', provisionerBefore.configuration, provisionerAfter.configuration));
  return broken;
}
