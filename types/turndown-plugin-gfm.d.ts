declare module 'turndown-plugin-gfm' {
  import TurndownService = require('turndown');

  export const highlightedCodeBlock: TurndownService.Plugin;
  export const strikethrough: TurndownService.Plugin;
  export const tables: TurndownService.Plugin;
  export const taskListItems: TurndownService.Plugin;
  export const gfm: TurndownService.Plugin;

  const pluginSet: {
    highlightedCodeBlock: TurndownService.Plugin;
    strikethrough: TurndownService.Plugin;
    tables: TurndownService.Plugin;
    taskListItems: TurndownService.Plugin;
    gfm: TurndownService.Plugin;
  };

  export default pluginSet;
}
