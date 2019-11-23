import { ExtensionContext, languages, commands, listManager, workspace } from 'coc.nvim'
import { CompletionItem, CompletionItemKind, Position, Range } from 'vscode-languageserver-types'
import DB from './db'
import YankList from './list/yank'
import { mkdirAsync, statAsync } from './util'

export async function activate(context: ExtensionContext): Promise<void> {
  let { subscriptions, storagePath } = context
  let stat = await statAsync(storagePath)
  if (!stat || !stat.isDirectory()) {
    await mkdirAsync(storagePath)
  }
  const config = workspace.getConfiguration('yank')
  let db = new DB(storagePath, config.get<number>('list.maxsize', 200))
  const maxLength = config.get<number>('byteLengthLimit', 10240)
  if (config.get<boolean>('highlight.enable', true)) {
    workspace.nvim.command('highlight default link HighlightedyankRegion IncSearch', true)
  }
  let winid: number
  subscriptions.push(listManager.registerList(new YankList(workspace.nvim, db)))
  subscriptions.push(commands.registerCommand('yank.clean', () => {
    db.clean()
  }))
  subscriptions.push(workspace.registerAutocmd({
    event: 'TextYankPost',
    arglist: ['v:event', "+expand('<abuf>')"],
    callback: async (event, bufnr) => {
      let { nvim } = workspace
      let { regtype, operator, regcontents } = event
      let doc = workspace.getDocument(bufnr)
      if (!doc) return
      let len = 0
      for (let s of regcontents) {
        len += Buffer.byteLength(s, 'utf8')
      }
      if (len > maxLength) return
      doc.forceSync()
      let [, lnum, col] = await nvim.call('getpos', ["'["])
      let character = byteSlice(doc.getline(lnum - 1), 0, col).length
      if (operator == 'y') {
        // highlight
        let enable = config.get<boolean>('highlight.enable', true)
        if (!enable) return
        winid = await nvim.call('win_getid')
        let ranges: Range[] = []
        let duration = config.get<number>('highlight.duration', 500)
        // block selection
        if (regtype.startsWith('\x16')) {
          let view = await nvim.call('winsaveview')
          await nvim.call('setpos', ['.', [0, lnum, col, 0]])
          for (let i = lnum; i < lnum + regcontents.length; i++) {
            let col = await nvim.call('col', ['.'])
            let line = doc.getline(i - 1)
            let startCharacter = byteSlice(line, 0, col - 1).length
            let start = Position.create(i - 1, startCharacter)
            let end = Position.create(i - 1, startCharacter + regcontents[i - lnum].length)
            ranges.push(Range.create(start, end))
            await nvim.command('normal! j')
          }
          await nvim.call('winrestview', [view])
        } else if (regtype == 'v') {
          let start = Position.create(lnum - 1, character)
          let endCharacter = regcontents.length == 1 ? character + regcontents[0].length - 1 : regcontents[regcontents.length - 1].length
          let end = Position.create(lnum + regcontents.length - 2, endCharacter)
          ranges.push(Range.create(start, end))
        } else if (regtype == 'V') {
          for (let i = lnum; i < lnum + regcontents.length; i++) {
            let line = doc.getline(i - 1)
            ranges.push(Range.create(i - 1, 0, i - 1, line.length))
          }
        } else {
          return
        }
        nvim.pauseNotification()
        let ids = doc.matchAddRanges(ranges, 'HighlightedyankRegion', 99)
        await nvim.resumeNotification()
        if (ids.length) {
          setTimeout(() => {
            nvim.call('coc#util#clearmatches', [ids], true)
          }, duration)
        }
      }
      let content = regcontents.join('\n')
      if (content.length < 4) return
      let path = `${doc.uri}\t${lnum}\t${col}`
      regtype = regtype.startsWith('\x16') ? '^v' : regtype
      await db.add(regcontents, regtype, path, doc.filetype)
    }
  }))

  languages.registerCompletionItemProvider('yank', 'YANK', null, {
    provideCompletionItems: async (document, _position, _token, context): Promise<CompletionItem[]> => {
      const config = workspace.getConfiguration('yank')
      let enabled = config.get<boolean>('enableCompletion', true)
      if (!enabled) return []
      let limit = config.get<number>('limit', 3)
      let { option } = context as any
      if (!option || !option.input) return
      let items = await db.load()
      items.reverse()
      items = items.filter(o => {
        if (o.regtype == '^v') return false
        return o.filetype == document.languageId && o.content[0].trim().startsWith(option.input)
      })
      let before_content = option.line.slice(0, option.col)
      if (!/^\s*$/.test(before_content)) {
        items = items.filter(o => o.regtype != 'V')
      }
      items = items.slice(0, limit)
      return items.map(item => {
        let ind = item.content.reduce((p, s) => {
          let ms = s.match(/^\s*/)[0]
          return Math.min(ms.length, p)
        }, Infinity)
        let lines = item.content.map((s, i) => {
          if (i == 0) return s.replace(/^\s*/, '')
          return s.slice(ind)
        })
        return {
          label: item.content[0].trim(),
          insertText: lines.join('\n'),
          kind: CompletionItemKind.Snippet,
          documentation: {
            kind: 'markdown',
            value: markdownBlock(lines.join('\n'), item.filetype)
          }
        } as CompletionItem
      })
    }
  }, [], config.get('priority', 9))
}

function byteSlice(content: string, start: number, end?: number): string {
  let buf = Buffer.from(content, 'utf8')
  return buf.slice(start, end).toString('utf8')
}

function markdownBlock(code: string, filetype: string): string {
  filetype = filetype == 'javascriptreact' ? 'javascript' : filetype
  filetype = filetype == 'typescriptreact' ? 'typescript' : filetype
  return '``` ' + filetype + '\n' + code + '\n```'
}
