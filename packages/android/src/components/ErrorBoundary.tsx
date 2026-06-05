import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

/**
 * Lightweight class error boundary. There is no other boundary in the app, so
 * a render throw in any screen/shared component unwinds to the root and React
 * unmounts everything — a permanent black screen. Wrapping each mode body (and
 * the nav root) means one crashing area shows a recoverable fallback while
 * module-level queue work and the other modes keep running.
 *
 * Colors are injected as props because a class component can't call the theme
 * hook.
 */
type BoundaryColors = {
  bg: string;
  text: string;
  muted: string;
  accent: string;
  onAccent: string;
  border: string;
};

type Props = {
  children: React.ReactNode;
  colors: BoundaryColors;
  /** Which area this guards, e.g. "Convert" — shown in the fallback copy. */
  label?: string;
};

type State = { error: Error | null };

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // Surface to Metro logs — never silently swallow.
    console.error(`[ErrorBoundary${this.props.label ? ` · ${this.props.label}` : ''}]`, error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const c = this.props.colors;
    return (
      <View style={[styles.wrap, { backgroundColor: c.bg }]}>
        <Text style={[styles.title, { color: c.text }]}>Something went wrong</Text>
        <Text style={[styles.detail, { color: c.muted }]} numberOfLines={5}>
          {this.props.label ? `The ${this.props.label} screen hit an error.\n` : ''}
          {error.message || String(error)}
        </Text>
        <Pressable
          onPress={this.reset}
          style={({ pressed }) => [
            styles.btn,
            { backgroundColor: c.accent, opacity: pressed ? 0.85 : 1 },
          ]}
          accessibilityRole="button"
          accessibilityLabel="Reload this screen"
        >
          <Text style={[styles.btnText, { color: c.onAccent }]}>Reload</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 12,
  },
  title: { fontSize: 17, fontWeight: '600' },
  detail: { fontSize: 13, textAlign: 'center', lineHeight: 19 },
  btn: {
    marginTop: 8,
    paddingVertical: 11,
    paddingHorizontal: 28,
    borderRadius: 10,
  },
  btnText: { fontSize: 14, fontWeight: '600' },
});
