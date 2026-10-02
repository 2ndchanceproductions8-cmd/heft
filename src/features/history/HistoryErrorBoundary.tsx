import { Component, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Button, EmptyState, Page, TopBar } from '../../components/ui';

interface Props {
  children: ReactNode;
  title: string;
  /** Back target for the fallback header (omit on tab roots, which use a large title). */
  back?: string;
}

/** Catches render errors (useLiveQuery rethrows IndexedDB failures) and offers a retry instead of a blank screen. */
export class HistoryErrorBoundary extends Component<Props, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[history]', error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const { title, back } = this.props;
    return (
      <Page tabBar>
        <TopBar title={title} large={!back} back={back} />
        <EmptyState
          icon={<TriangleAlert className="h-7 w-7" />}
          title="Something went wrong"
          message={this.state.error.message || 'Your workouts could not be loaded.'}
          action={<Button onClick={() => this.setState({ error: null })}>Try Again</Button>}
        />
      </Page>
    );
  }
}
