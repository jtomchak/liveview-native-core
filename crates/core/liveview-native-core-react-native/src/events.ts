export function clickEvent(attributes: Readonly<Record<string, string | null>> = {}) {
  const event = attributes['phx-click'];
  if (!event) return null;
  const value: Record<string, string> = {};
  for (const [name, attribute] of Object.entries(attributes)) {
    if (name.startsWith('phx-value-') && name.length > 'phx-value-'.length && attribute !== null) {
      Object.defineProperty(value, name.slice('phx-value-'.length), {
        value: attribute, enumerable: true, writable: true, configurable: true,
      });
    }
  }
  return { event, value };
}
