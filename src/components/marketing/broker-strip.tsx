import { BROKERS } from "@/lib/brokers";
import { BrokerMark } from "@/components/brokers/broker-mark";
import { Container } from "@/components/marketing/container";

/** The 12-broker strip under the hero. Registry-driven; order follows lib/brokers. */
export function BrokerStrip() {
  return (
    <div className="border-t border-border bg-card/40">
      <Container className="grid gap-4 py-8">
        <ul aria-label="Supported brokers" className="flex flex-wrap items-center gap-x-6 gap-y-3">
          {BROKERS.map((b) => (
            <li key={b.id} className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <BrokerMark id={b.id} size="sm" />
              {b.name}
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">Connected through OAuth. Nasscord never sees a broker password.</p>
      </Container>
    </div>
  );
}
