import type {
  Action,
  AliasBinding,
  CommandExpressionNode,
  ForwardOptions,
  ModuleBinding,
  Position,
} from '@1hive/evmcrispr';
import {
  BindingsManager,
  BindingsSpace,
  EVMcrispr,
  NodeType,
  isProviderAction,
  parseScript,
} from '@1hive/evmcrispr';
import MonacoEditor, { useMonaco } from '@monaco-editor/react';
import { useChain, useSpringRef } from '@react-spring/web';
import {
  Alert,
  AlertDescription,
  AlertIcon,
  Box,
  Button,
  Spinner,
  VStack,
  useDisclosure,
} from '@chakra-ui/react';
import { useEffect, useState } from 'react';
import type { Connector } from 'wagmi';
import { useAccount, useConnect, useDisconnect, useProvider } from 'wagmi';
import { InjectedConnector } from 'wagmi/connectors/injected';
import type { providers } from 'ethers';

import type { IRange, languages } from 'monaco-editor';

import { theme } from '../../editor/theme';
import { conf, contribution } from '../../editor/evmcl';

import SelectWalletModal from '../../components/modal';
import FadeIn from '../../components/animations/fade-in';
import Footer from '../../components/footer';
import { terminalStoreActions, useTerminalStore } from './use-terminal-store';
import {
  buildModuleCompletionItems,
  buildVarCompletionItems,
  getCommandFromModule,
  getModuleBindings,
  resolveAliases,
  runEagerExecutions,
} from '../../utils/autocompletion';

// TODO: Migrate logic to evmcrispr
const executeActions = async (
  actions: Action[],
  connector: Connector,
  options?: ForwardOptions,
): Promise<providers.TransactionReceipt[]> => {
  const txs = [];

  if (!(connector instanceof InjectedConnector)) {
    throw new Error(
      `Provider action-returning commands are only supported by injected wallets (e.g. Metamask)`,
    );
  }

  for (const action of actions) {
    if (isProviderAction(action)) {
      const [chainParam] = action.params;

      await connector.switchChain(Number(chainParam.chainId));
    } else {
      const signer = await connector.getSigner();
      txs.push(
        await (
          await signer.sendTransaction({
            ...action,
            gasPrice: options?.gasPrice,
            gasLimit: options?.gasLimit,
          })
        ).wait(),
      );
    }
  }
  return txs;
};

const hasCommandsBlock = (c: CommandExpressionNode): boolean =>
  !!c.args.find((arg) => arg.type === NodeType.BlockExpression);
const calculateCommandNameLength = (c: CommandExpressionNode) =>
  (c.module + (c.module ? ':' : '') + c.name).length;

export const Terminal = () => {
  const monaco = useMonaco();
  const { bindingsCache, ipfsResolver, errors, isLoading, script } =
    useTerminalStore();
  const { data: account } = useAccount();
  const { activeConnector } = useConnect();
  const { disconnect } = useDisconnect();
  const provider = useProvider();
  // const { data: signer } = useSigner();
  const { isOpen, onOpen, onClose } = useDisclosure();
  const terminalRef = useSpringRef();
  const buttonsRef = useSpringRef();
  const footerRef = useSpringRef();
  const [url] = useState('');

  const address = account?.address ?? '';
  const addressShortened = `${address.slice(0, 6)}..${address.slice(-4)}`;
  const forwardingText = `Forwarding from ${addressShortened}`;

  useChain([terminalRef, buttonsRef, footerRef]);

  useEffect(() => {
    if (!monaco) {
      return;
    }

    console.log('SETTING LANGUAGE');

    // const moduleNames = Object.keys(modules);

    // const commands = moduleNames.flatMap((n) => modules[n].commands);

    // const helpers = moduleNames.flatMap((n) => modules[n].helpers);

    // const tokensProvider = monaco.languages.setMonarchTokensProvider(
    //   'evmcl',

    //   createLanguage(commands, helpers),
    // );

    // return () => {
    //   tokensProvider.dispose();
    // };
  }, [monaco]);

  useEffect(() => {
    if (!monaco || !provider) {
      return;
    }
    console.log('REGISTERING COMPLETION ITEM');

    const completionProvider = monaco.languages.registerCompletionItemProvider(
      'evmcl',
      {
        provideCompletionItems: async (model, currPos) => {
          console.log('CALLING FUNCTION');
          const { ast } = parseScript(model.getValue());

          const lineContent = model.getLineContent(currPos.lineNumber).trim();
          const emptyLine = !lineContent.length;
          const { startColumn, endColumn } =
            model.getWordUntilPosition(currPos);

          const range: IRange = {
            startLineNumber: currPos.lineNumber,
            endLineNumber: currPos.lineNumber,
            startColumn: startColumn,
            // If word exists retrieve the column where it ends
            endColumn: model.getWordAtPosition(currPos)?.endColumn ?? endColumn,
          };
          const calibratedPos: Position = {
            // Monaco editor positions start at 1
            col: currPos.column - 1,
            line: currPos.lineNumber,
          };

          // Prepare eager bindings manager
          const eagerBindingsManager = new BindingsManager();

          // Get command nodes
          const commandNodes: CommandExpressionNode[] =
            ast.getCommandsUntilLine(currPos.lineNumber, ['load', 'set']);

          // Build module bindings
          const moduleAndAliasBindings = await getModuleBindings(
            commandNodes,
            bindingsCache,
            provider,
            ipfsResolver,
            calibratedPos,
          );
          const moduleBindings = moduleAndAliasBindings.filter<ModuleBinding>(
            (b): b is ModuleBinding => b.type === BindingsSpace.MODULE,
          );
          const aliasBindings = moduleAndAliasBindings.filter<AliasBinding>(
            (b): b is AliasBinding => b.type === BindingsSpace.ALIAS,
          );

          // Resolve module aliases
          const restOfCommandNodes = resolveAliases(
            commandNodes.filter((c) => c.name !== 'load'),
            aliasBindings,
          );
          const currentCommandNode =
            restOfCommandNodes[restOfCommandNodes.length - 1];

          // Build module completion items
          const { commandCompletionItems, helperCompletionItems } =
            await buildModuleCompletionItems(
              moduleBindings,
              range,
              aliasBindings,
            );

          const c = commandNodes[commandNodes.length - 1];
          const typingCommand =
            emptyLine ||
            // Caret position is within command name location
            (!!c.loc &&
              calibratedPos.col >= c.loc.start.col &&
              calibratedPos.col <= calculateCommandNameLength(c));

          if (typingCommand) {
            return {
              suggestions: commandCompletionItems,
            };
          }

          const filteredCommandNodes = restOfCommandNodes
            .filter((c) => {
              const itHasCommandsBlock = hasCommandsBlock(c);
              const loc = c.loc;
              const currentLine = currPos.lineNumber;
              return (
                !itHasCommandsBlock ||
                (itHasCommandsBlock &&
                  loc &&
                  loc.start.line >= currentLine &&
                  currentLine <= loc.end.line)
              );
            })
            // Filter out command nodes with unknown module prefixes
            .filter((c) => {
              const command = getCommandFromModule(c, moduleBindings);
              return !!command;
            });

          // Get bindings from eager execution functions
          const eagerBindings = await runEagerExecutions(
            filteredCommandNodes,
            moduleBindings,
            bindingsCache,
            provider,
            ipfsResolver,
            calibratedPos,
          );

          eagerBindings.forEach((binding, i) => {
            if (!binding) {
              return;
            }
            const commandNode = filteredCommandNodes[i];

            if (hasCommandsBlock(commandNode)) {
              eagerBindingsManager.enterScope();
            }

            eagerBindingsManager.mergeBindings(binding);
          });

          const variableCompletionItems = buildVarCompletionItems(
            eagerBindingsManager,
            range,
          );

          let currentArgCompletions: languages.CompletionItem[] = [];
          const lastCommand = getCommandFromModule(
            currentCommandNode,
            moduleBindings,
          );

          if (lastCommand) {
            if (lastCommand.buildCompletionItemsForArg) {
              currentArgCompletions = lastCommand
                .buildCompletionItemsForArg(
                  currentCommandNode.args.length,
                  currentCommandNode.args,
                  eagerBindingsManager,
                )
                .map<languages.CompletionItem>((identifier) => ({
                  label: identifier,
                  insertText: identifier,
                  range,
                  kind: 3,
                }));
            }
          }

          // Update cache with latest bindings
          terminalStoreActions.updateCacheBindings(
            moduleBindings,
            eagerBindings,
          );

          return {
            suggestions: [
              ...currentArgCompletions,
              ...helperCompletionItems,
              ...variableCompletionItems,
            ],
          };
        },
      },
    );

    return () => {
      completionProvider.dispose();
    };
  }, [bindingsCache, monaco, provider, ipfsResolver]);

  async function onDisconnect() {
    terminalStoreActions.errors([]);
    disconnect();
  }

  async function onExecute() {
    terminalStoreActions.errors([]);
    terminalStoreActions.isLoading(true);

    try {
      const signer = await activeConnector?.getSigner();
      if (!activeConnector || signer === undefined || signer === null)
        throw new Error('Account not connected');

      const { ast, errors } = parseScript(script);

      if (errors.length) {
        terminalStoreActions.isLoading(false);
        terminalStoreActions.errors(errors);
        return;
      }
      const actions = await new EVMcrispr(ast, signer).interpret();

      await executeActions(actions, activeConnector, { gasLimit: 10_000_000 });

      // TODO: adapt to cas11 changes
      // const chainId = (await signer.provider?.getNetwork())?.chainId;
      // setUrl(`https://${client(chainId)}/#/${connectedDAO.kernel.address}/${}`);
    } catch (err: any) {
      const e = err as Error;
      console.error(e);
      if (
        e.message.startsWith('transaction failed') &&
        /^0x[0-9a-f]{64}$/.test(e.message.split('"')[1])
      ) {
        terminalStoreActions.errors([
          `Transaction failed, watch in block explorer ${
            e.message.split('"')[1]
          }`,
        ]);
      } else {
        terminalStoreActions.errors([e.message]);
      }
    } finally {
      terminalStoreActions.isLoading(false);
    }
  }

  return (
    <>
      <Box maxWidth="956px" margin="0 auto" my={16}>
        <FadeIn componentRef={terminalRef}>
          <MonacoEditor
            height="50vh"
            theme="theme"
            language="evmcl"
            value={script}
            onChange={(str) => terminalStoreActions.script(str || '')}
            beforeMount={(monaco) => {
              monaco.editor.defineTheme('theme', theme);
              monaco.languages.register(contribution);
              monaco.languages.setLanguageConfiguration('evmcl', conf);
            }}
            onMount={(editor) => {
              editor.setPosition({ lineNumber: 10000, column: 0 });
              editor.focus();
            }}
            options={{
              fontSize: 22,
              fontFamily: 'Ubuntu Mono',
              detectIndentation: false,
              tabSize: 2,
              language: 'evmcl',
              minimap: {
                enabled: false,
              },
              scrollbar: {
                useShadows: false,
                verticalScrollbarSize: 7,
                vertical: 'hidden',
              },
            }}
          />
        </FadeIn>
        <FadeIn componentRef={buttonsRef}>
          <VStack mt={3} alignItems="flex-end" gap={3} pr={{ base: 6, lg: 0 }}>
            {!address ? (
              <Button variant="lime" onClick={onOpen}>
                Connect
              </Button>
            ) : (
              <>
                {url ? (
                  <Button
                    variant="warning"
                    onClick={() => window.open(url, '_blank')}
                  >
                    Go to vote
                  </Button>
                ) : null}

                <Button variant="lime" onClick={onExecute} disabled={isLoading}>
                  {isLoading ? (
                    <Box>
                      <Spinner verticalAlign="middle" /> {forwardingText}
                    </Box>
                  ) : (
                    forwardingText
                  )}
                </Button>
                <Button
                  variant="link"
                  color="white"
                  onClick={onDisconnect}
                  size="sm"
                >
                  Disconnect
                </Button>
              </>
            )}

            {errors ? (
              <Box justifyContent="left">
                {errors.map((e, index) => (
                  <Alert key={index} status="error">
                    <AlertIcon />
                    <AlertDescription>{e}</AlertDescription>
                  </Alert>
                ))}
              </Box>
            ) : null}
          </VStack>
        </FadeIn>
      </Box>
      <FadeIn componentRef={footerRef}>
        <Footer />
      </FadeIn>
      <SelectWalletModal isOpen={isOpen} closeModal={onClose} />
    </>
  );
};
