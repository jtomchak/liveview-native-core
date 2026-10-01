/** Only numeric measurements and fixed protocol labels belong here, never document/user data. */
export type TelemetryEvent = Readonly<{ name: string; at: number; attributes: Readonly<Record<string, string | number | boolean>> }>;
export type TelemetrySink = (event: TelemetryEvent) => void;
let sink: TelemetrySink | undefined;
export const clock = () => performance.now();
export function setTelemetrySink(next?: TelemetrySink) { sink = next; }
export function measure(name: string, attributes: TelemetryEvent['attributes'] = {}) {
  try { sink?.({ name: `lvn.${name}`, at: clock(), attributes }); } catch { /* Observability must not break the app. */ }
}
