# Tip #1: Seed your feature work with real data from integration

When you start building a new feature, make "import data from integration" the
**first step of your plan**. Real data beats hand-crafted fixtures for catching
the edge cases that actually show up in production.

The nice part: you can hand this off to your favorite coding agent. Ask it to
import data from the integration environment as step one, and it'll find the
integration URL in the docs on its own.

**One important thing to spell out:** tell it explicitly to use the **API** to
export and import the data. Left to its own devices, an agent will often reach
for a direct database connection, which you don't want.

This technique works really well whether you're testing a migration or just
building a new UI feature that needs realistic data to look right.
