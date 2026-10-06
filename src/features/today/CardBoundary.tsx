import { Component, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { Button, Card } from '../../components/ui';

/**
 * One dashboard card's error boundary: a card that throws (useLiveQuery rethrows IndexedDB failures) shows a
 * small retry box instead of taking the other cards down with it.
 */
export class CardBoundary extends Component<{ title: string; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`[today:${this.props.title}]`, error.message);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <Card className="flex items-center gap-3 p-4">
        <TriangleAlert className="h-5 w-5 shrink-0 text-warn" />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold">{this.props.title} couldn't load</div>
          <div className="truncate text-[13px] text-muted">{this.state.error.message || 'Something went wrong'}</div>
        </div>
        <Button variant="secondary" onClick={() => this.setState({ error: null })}>
          Retry
        </Button>
      </Card>
    );
  }
}
