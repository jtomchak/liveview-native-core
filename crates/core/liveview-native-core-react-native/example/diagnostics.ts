import type { TelemetryEvent } from '@liveview-native/react-native';
export class DiagnosticBuffer {
  private samples: readonly TelemetryEvent[] = [];
  getSnapshot = () => this.samples;
  record(event: TelemetryEvent): boolean {
    // Profiler callbacks must not change a React external store snapshot.
    if (event.name === 'lvn.react.commit') return false;
    this.samples = [...this.samples.slice(-119), event];
    return true;
  }
}
