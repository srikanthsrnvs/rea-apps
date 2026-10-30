// Resolve exact menu names/IDs, never fuzzy ingredient or recipe guesses.
const same = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  a.trim().toLocaleLowerCase('en-US') === b.trim().toLocaleLowerCase('en-US');
const fail = (message) => {
  throw Object.assign(new Error(message), { code: 'EATS_CHOICES_INVALID' });
};
export function resolveEatsChoices(detail, choices) {
  if (!Array.isArray(choices) || choices.length > 100)
    fail('choices must be an array of at most 100 named choices');
  const index = [];
  function scan(groups, path = [], depth = 0) {
    if (depth > 12) fail('Customization nesting exceeds 12 levels');
    for (const group of groups) {
      const full = [...path, group.name ?? group.groupId];
      index.push({ group, path: full });
      for (const option of group.options ?? [])
        scan(
          option.childGroups ?? [],
          [...full, option.name ?? option.optionId],
          depth + 1,
        );
    }
  }
  scan(detail.modifierGroups ?? []);
  const explicit = new Map();
  for (const choice of choices) {
    if (
      !choice ||
      typeof choice !== 'object' ||
      Array.isArray(choice) ||
      Object.keys(choice).some(
        (k) => !['group', 'option', 'quantity', 'path'].includes(k),
      )
    )
      fail(
        'Each choice needs group, option, optional quantity and optional path',
      );
    const candidates = index.filter(
      ({ group, path }) =>
        (same(group.name, choice.group) || group.groupId === choice.group) &&
        (!choice.path ||
          (Array.isArray(choice.path) &&
            [path, path.slice(0, -1)].some(
              (candidate) =>
                candidate.length === choice.path.length &&
                candidate.every((name, i) => same(name, choice.path[i])),
            ))),
    );
    if (candidates.length !== 1)
      fail(
        `Unknown or ambiguous choice group ${String(choice.group)}. Use an exact group name/ID, and its full path when ambiguous.`,
      );
    const group = candidates[0].group,
      options = group.options.filter(
        (option) =>
          same(option.name, choice.option) || option.optionId === choice.option,
      );
    if (options.length !== 1)
      fail(
        `Unknown or ambiguous option ${String(choice.option)} in ${group.name}. Use an exact option name or ID from item detail.`,
      );
    const option = options[0],
      quantity = choice.quantity ?? 1;
    if (!Number.isSafeInteger(quantity) || quantity < 0)
      fail('Choice quantity must be a nonnegative integer per item');
    const selected = explicit.get(group) ?? [];
    if (selected.some((value) => value.optionId === option.optionId))
      fail('Duplicate named option');
    selected.push({ optionId: option.optionId, quantity });
    explicit.set(group, selected);
  }
  const used = new Set();
  function build(groups, depth = 0) {
    if (depth > 12) fail('Customization nesting exceeds 12 levels');
    return groups.flatMap((group) => {
      const selected =
        explicit.get(group) ??
        group.options
          .filter(
            (o) =>
              Number.isSafeInteger(o.defaultQuantity) && o.defaultQuantity > 0,
          )
          .map((o) => ({ optionId: o.optionId, quantity: o.defaultQuantity }));
      if (explicit.has(group)) used.add(group);
      const options = selected
        .filter((o) => o.quantity > 0)
        .map((selected) => {
          const option = group.options.find(
            (o) => o.optionId === selected.optionId,
          );
          return {
            uuid: option.optionId,
            quantity: selected.quantity,
            customizationV2List: build(option.childGroups ?? [], depth + 1),
          };
        });
      return options.length
        ? [{ uuid: group.groupId, childOptions: { options } }]
        : [];
    });
  }
  const selections = build(detail.modifierGroups ?? []);
  if ([...explicit.keys()].some((key) => !used.has(key)))
    fail(
      'A nested choice belongs to an unselected parent option. Select its parent explicitly.',
    );
  return selections;
}
