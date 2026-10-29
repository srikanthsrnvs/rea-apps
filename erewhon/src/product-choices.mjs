import { fail } from './ordering-protocol.mjs';

export const normalizeLabel = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
const label = value => value.label || value.name;

function match(values, wanted, kind) {
  const matches = values.filter(value => [value.label, value.name].some(text => normalizeLabel(text) === normalizeLabel(wanted)));
  if (matches.length !== 1) fail('CHOICE_UNAVAILABLE', `${kind} “${wanted}” is missing or ambiguous. Read product options and update the recipe; no cart change was sent.`,{orderPrepared:false,orderPlaced:false,requested:wanted,kind,available:values.map(label),nextAction:'Correct the request using an exact available label, then call order_prepare again. Do not quote a price until it succeeds.'});
  return matches[0];
}

export function namedSelections(product, { size, choices = [] } = {}) {
  if (!Array.isArray(choices) || choices.length > 100) fail('INVALID_ARGUMENT', 'choices must be an array of {group, option, count}.');
  let groups = product.modifier_groups;
  let modifierSizeId;
  if (product.modifier_size?.length) {
    if (!size) fail('SIZE_REQUIRED', 'Choose a named size from product options.');
    const selected = match(product.modifier_size, size, 'Size');
    modifierSizeId = selected._id;
    groups = selected.modifier_groups;
  } else if (size) fail('CHOICE_UNAVAILABLE', 'This product does not offer the requested size.');
  const sets = groups?.modifier_sets ?? [];
  const selected = new Map();
  for (const choice of choices) {
    if (!choice || typeof choice.group !== 'string' || !choice.group.trim() || typeof choice.option !== 'string' || !choice.option.trim()
      || !Number.isInteger(choice.count ?? 1) || (choice.count ?? 1) < 1 || (choice.count ?? 1) > 100) fail('INVALID_ARGUMENT', 'Each choice needs a group name, option name and positive integer count.');
    const group = match(sets, choice.group, 'Modifier group');
    const item = match(group.modifiers ?? [], choice.option, 'Modifier');
    const key = `${group._id}:${item._id}`;
    if (selected.has(key)) fail('INVALID_ARGUMENT', 'A named modifier was selected more than once.');
    selected.set(key, { groupId: group._id, modifierId: item._id, count: choice.count ?? 1 });
  }
  return { modifierSizeId, modifiers: [...selected.values()] };
}

export function productOptions(product) {
  const project = groups => (groups?.modifier_sets ?? []).map(group => ({
    group: label(group), required: group.required === true || group.required === 'true',
    minimum: Number(group.minimum || 0), maximum: Number(group.maximum || 0),
    options: (group.modifiers ?? []).map(option => ({ option: label(option), defaultCount:1, maxAllowedCount:option.maximum })),
  }));
  return {
    productRef: String(product.internal_product_id ?? ''), name: product.name, sku: product.sku,
    referenceKind:'catalog_reference', modifierCountRule:'Each selected option defaults to ONE per item. Omit count unless the user explicitly requests multiple portions. maxAllowedCount is only a limit; never use it as the requested count.',
    sizes: (product.modifier_size ?? []).map(size => ({ size: label(size), groups: project(size.modifier_groups) })),
    groups: project(product.modifier_groups),
    status:'options_only',orderPrepared:false,orderPlaced:false,nextTool:'order_prepare',
    next: 'These are choices, not a checkout or price quote. Call order_prepare with the exact size/group/option labels to get the real total. Do not report an order as ready before it succeeds.',
  };
}
