import { vi } from 'vitest';

export const StatusBarAlignment = { Left: 1, Right: 2 };

export class ThemeColor {
  constructor(public id: string) {}
}

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
export const ViewColumn = { One: 1, Two: 2, Three: 3 };

export class EventEmitter {
  private listeners: Function[] = [];

  event = (listener: Function) => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };

  fire(data?: unknown) {
    this.listeners.forEach((l) => l(data));
  }

  dispose() {
    this.listeners = [];
  }
}

export class Disposable {
  constructor(private callOnDispose: () => void) {}
  dispose() {
    this.callOnDispose();
  }
}

const mockConfigValues: Record<string, unknown> = {};

export function setMockConfig(values: Record<string, unknown>) {
  Object.assign(mockConfigValues, values);
}

export function clearMockConfig() {
  for (const key of Object.keys(mockConfigValues)) {
    delete mockConfigValues[key];
  }
}

const mockConfiguration = {
  get: vi.fn((key: string, defaultValue?: unknown) => {
    return key in mockConfigValues ? mockConfigValues[key] : defaultValue;
  }),
  update: vi.fn(),
  has: vi.fn(() => true),
  inspect: vi.fn(),
};

export const workspace = {
  getConfiguration: vi.fn(() => mockConfiguration),
  onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
};

const mockStatusBarItem = {
  text: '',
  tooltip: '',
  command: '',
  backgroundColor: undefined as unknown,
  show: vi.fn(),
  hide: vi.fn(),
  dispose: vi.fn(),
};

const mockOutputChannel = {
  appendLine: vi.fn(),
  show: vi.fn(),
  dispose: vi.fn(),
};

export const window = {
  createStatusBarItem: vi.fn(() => ({ ...mockStatusBarItem })),
  createOutputChannel: vi.fn(() => ({ ...mockOutputChannel })),
  createWebviewPanel: vi.fn(() => ({
    webview: { html: '', onDidReceiveMessage: vi.fn() },
    reveal: vi.fn(),
    dispose: vi.fn(),
    onDidDispose: vi.fn(),
  })),
  showInformationMessage: vi.fn(),
  showWarningMessage: vi.fn(),
  showErrorMessage: vi.fn(),
};

export const commands = {
  registerCommand: vi.fn(() => ({ dispose: vi.fn() })),
};

export const Uri = {
  file: (path: string) => ({ fsPath: path, scheme: 'file' }),
  parse: (str: string) => ({ fsPath: str, scheme: 'file' }),
};
