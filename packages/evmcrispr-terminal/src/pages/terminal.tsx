import { useEffect, useState } from 'react';

import { IPFSResolver } from '@1hive/evmcrispr';
import { useAccount, useConnect, useDisconnect, useProvider } from 'wagmi';
import type { Monaco } from '@monaco-editor/react';

import MonacoEditor, { useMonaco } from '@monaco-editor/react';
import { useChain, useSpringRef } from '@react-spring/web';
import { Button, Container, VStack, useDisclosure } from '@chakra-ui/react';

import {
  conf,
  contribution,
  createLanguage,
  getModulesKeywords,
} from '../editor/evmcl';
import { createProvideCompletionItemsFn } from '../editor/autocompletion';
import { theme } from '../editor/theme';

import {
  terminalStoreActions,
  useTerminalStore,
} from '../hooks/use-terminal-store';
import { useDebounce } from '../hooks/useDebounce';

import FadeIn from '../components/animations/fade-in';
import Footer from '../components/footer';
import ActionButtons from '../components/action-buttons';
import SelectWalletModal from '../components/wallet-modal';

const ipfsResolver = new IPFSResolver();

export default function Terminal() {
  const [firstTry, setFirstTry] = useState(true);
  const terminalRef = useSpringRef();
  const buttonsRef = useSpringRef();
  const footerRef = useSpringRef();

  const {
    isOpen: isWalletModalOpen,
    onOpen: onWalletModalOpen,
    onClose: onWalletModalClose,
  } = useDisclosure();

  const monaco = useMonaco();
  const { bindingsCache, errors, isLoading, script, ast, currentModuleNames } =
    useTerminalStore();

  const { data: account } = useAccount();
  const { connectors, connect, isConnected, isConnecting } = useConnect();
  const provider = useProvider();
  const { disconnect } = useDisconnect();

  const address = account?.address ?? '';

  const debouncedScript = useDebounce(script, 200);

  useChain([terminalRef, buttonsRef, footerRef]);

  /**
   * Try to connect as soon as page mounts
   * to have access to a provider to use on
   * auto-completion
   */
  useEffect(() => {
    if (!firstTry || isConnected) {
      return;
    }
    connect(connectors[0]);
    setFirstTry(false);
  }, [firstTry, connect, connectors, isConnected]);

  useEffect(() => {
    terminalStoreActions.processScript();
  }, [debouncedScript]);

  useEffect(() => {
    if (!monaco) {
      return;
    }
    const { commandKeywords, helperKeywords } = getModulesKeywords(
      currentModuleNames,
      bindingsCache,
    );

    const tokensProvider = monaco.languages.setMonarchTokensProvider(
      'evmcl',
      createLanguage(commandKeywords, helperKeywords),
    );

    return () => {
      tokensProvider.dispose();
    };
  }, [monaco, currentModuleNames, bindingsCache]);

  useEffect(() => {
    if (!monaco || !provider) {
      return;
    }
    const completionProvider = monaco.languages.registerCompletionItemProvider(
      'evmcl',
      {
        provideCompletionItems: createProvideCompletionItemsFn(
          bindingsCache,
          { provider, ipfsResolver },
          ast,
        ),
      },
    );

    return () => {
      completionProvider.dispose();
    };
  }, [bindingsCache, monaco, provider, ast]);

  // Set up a script if we have one in the URL
  useEffect(() => {
    const encodedScript = new URLSearchParams(
      window.location.hash.split('?')[1],
    ).get('script');
    if (encodedScript) {
      terminalStoreActions.script(encodedScript);
      terminalStoreActions.processScript();
    }
  }, []);

  function handleOnChangeEditor(str: string | undefined, ev: any) {
    terminalStoreActions.script(str ?? '');
    const change = ev.changes[0];
    const startLineNumber = change.range.startLineNumber;
    const newLine = change.text
      ? change.text.split('\n').length +
        startLineNumber -
        // Substract current line
        1
      : startLineNumber;
    terminalStoreActions.updateCurrentLine(newLine);
  }

  function handleBeforeMountEditor(monaco: Monaco) {
    monaco.editor.defineTheme('theme', theme);
    monaco.languages.register(contribution);
    monaco.languages.setLanguageConfiguration('evmcl', conf);
  }

  function handleOnMountEditor(editor: any) {
    editor.setPosition({ lineNumber: 10000, column: 0 });
    editor.focus();
  }

  async function onDisconnect() {
    terminalStoreActions.errors([]);
    disconnect();
  }

  return (
    <>
      <Container maxWidth="8xl" my={16}>
        <FadeIn componentRef={terminalRef}>
          <VStack mb={3} alignItems="flex-end" pr={{ base: 6, lg: 0 }}>
            {address ? (
              <Button
                variant="link"
                color="white"
                onClick={onDisconnect}
                size="sm"
              >
                Disconnect
              </Button>
            ) : (
              <Button
                variant="lime"
                isLoading={isConnecting}
                loadingText={'Connecting…'}
                onClick={onWalletModalOpen}
              >
                Connect
              </Button>
            )}
          </VStack>
          <MonacoEditor
            height="50vh"
            theme="theme"
            language="evmcl"
            value={script}
            onChange={handleOnChangeEditor}
            beforeMount={handleBeforeMountEditor}
            onMount={handleOnMountEditor}
            options={{
              fontSize: 22,
              fontFamily: 'Ubuntu Mono',
              detectIndentation: false,
              quickSuggestionsDelay: 100,
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
          <ActionButtons
            address={address}
            terminalStoreActions={terminalStoreActions}
            terminalStoreState={{
              errors,
              isLoading,
              script,
            }}
          />
        </FadeIn>
      </Container>
      <FadeIn componentRef={footerRef}>
        <Footer />
      </FadeIn>
      <SelectWalletModal
        isOpen={isWalletModalOpen}
        onClose={onWalletModalClose}
      />
    </>
  );
}