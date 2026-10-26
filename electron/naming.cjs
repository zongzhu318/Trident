const NAME_MAX = 100;
const normalized = (name) => name.toLowerCase();
const suffixPattern = /^(.*) \((\d+)\)$/;

function uniqueName(name, taken = [], max = NAME_MAX) {
  const used = new Set(taken.map(normalized));
  if (!used.has(normalized(name))) return name;
  const matched = suffixPattern.exec(name);
  const root = matched ? matched[1] : name;
  let index = matched ? Number(matched[2]) + 1 : 2;
  for (;;) {
    const suffix = ` (${index})`;
    const candidate = `${root.slice(0, max - suffix.length).trimEnd()}${suffix}`;
    if (!used.has(normalized(candidate))) return candidate;
    index += 1;
  }
}

function uniqueNames(profiles, reserved = [], max = NAME_MAX) {
  const taken = reserved.slice();
  return profiles.map((profile) => {
    const name = uniqueName(profile.name, taken, max);
    taken.push(name);
    return name === profile.name ? profile : { ...profile, name };
  });
}

module.exports = { uniqueName, uniqueNames, NAME_MAX };
