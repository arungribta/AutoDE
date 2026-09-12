/**
 * @deprecated Use `./languageModelAdapter` instead.
 *
 * This module used to hold the Copilot-only `vscode.lm` wrapper. It is now a
 * vendor-agnostic adapter (GitHub Copilot **or** Claude via the VS Code
 * Language Model API). This file is kept as a re-export shim so existing
 * `require('./copilotAdapter')` call sites and tests continue to work.
 */
export {
  LanguageModelAdapter,
  CopilotAdapter,
  type LanguageModelInfo,
  type LanguageModelDescriptor,
  type LanguageModelProviderKind,
  type CopilotInfo,
  type CopilotModelInfo
} from './languageModelAdapter';
