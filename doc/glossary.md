# Glossary

For anyone reading the console or the API: every word washtrace uses with a meaning of its own, in one place. The
pages are in [console.md](console.md), and the methods behind the words in [methods.md](methods.md).

## The lenses

- **Lens.** One rule for what counts as a wash trade. There are three built in, from the paper, and any number of
  [yours](console.md#your-own-lenses) (`L7` in the API is your lens with id 7). The console names a lens in plain
  words first and keeps the paper's code in brackets: Round trips (A).
- **Round trips (A) · the floor.** The token itself went round a loop of wallets. It needs no money data, and is
  the least the console claims.
- **Linked wallets (AC) · the ceiling.** Round trips, plus trades whose two wallets are joined by money within two
  hops. It is the most the console claims.
- **Money loops back (AU) · not counted.** The money from a sale went back to the seller, up to 30 wallets deep.
  It still runs and keeps its tab, but it failed the [placebo test](methods.md#why-the-headline-leaves-money-loops-back-out),
  so it is never in the headline, the shares or a ring.
- **The range.** The headline: the share from the floor to the ceiling. The console lists the lenses in that
  order, floor, ceiling, then the one not counted. The API and CSV keep the paper's order, A, AU, AC.
- **Not run.** A lens that needs money data and has none says so, and shows no share, never 0%.

## Trades

- **Transfer.** One ERC-721 Transfer event: a mint, a burn, a sale, a gift, a move into or out of custody.
- **Sale.** A transfer inside a known marketplace's transaction (Seaport, Blur, LooksRare v2, X2Y2). Seaport sales
  carry a price; the others are marked but not priced.
- **Trade, or change of owner.** A transfer that moves a token from one owner to another. Mints, burns and custody
  are not trades. A lens judges sales, or every change of owner (the paper's Tables 3 and 4).
- **Judged.** Looked at by a lens. "Not judged yet" is a trade past the block the latest analysis or lens run read
  to. It is never shown as clean, and over the API it is `judged: false`, never `washTrade: false`.
- **Flagged.** A lens judged the trade and it fits the rule. **Not flagged** is judged and does not fit.
- **Share.** The part of the trades a lens judged that it flags. The collection page leads with sales; the
  analysis also gives changes of owner and volume. See [methods.md](methods.md#shares) on reading the volume share.
- **So far / at least.** "So far": reads still running can move the share. "At least": waiting will not close it
  (a search cap, a missing Etherscan key, a limit), so the true share is this or more.
- **7-day median.** On the Trades page, the median price of the collection's priced sales over the 7 UTC days
  before a sale's day (`FLOOR_DAYS`). It stands where a floor price would, but washtrace reads no listings, so it
  is not the lowest ask. "vs 7-day median" is a sale's price divided by it: 0.5× is half, 2× is double.
- **Held** and **buyer age.** How long the token sat still before this sale, and how long before it the buyer first
  appeared in the collection.

## Why a trade is flagged

- **Witness.** The evidence a lens keeps for each flag: a loop, or a linked pair. The console draws it and says it in
  a sentence; the API returns it as data.
- **Loop.** Wallets the token went round, from a seller back to them (a strongly connected component of the token's
  graph). A loop **closed by money** is one where a payment, not the token, makes the way back.
- **Cycles.** How many independent ways round a loop has: its edges minus its wallets plus one. A sale and a
  buy-back is 1 cycle; a token sold back and forth four times between two wallets is 3. Round trips needs 2
  (`minCycles`), so a single buy-back is not flagged.
- **Linked pair.** A seller and buyer that money joins: one paid the other, or both were paid by, or both paid, the
  same wallet.
- **Middle, or in between.** The wallet that joins a linked pair, or that a loop's money passes through. An
  exchange or any wallet joined to more than 20 of the collection's wallets (`hubDegree`) is never a middle.

## Rings

- **Ring.** The wallets the counted evidence joins: loops and linked pairs that share a wallet are one ring. It
  answers "who did this together", flags nothing of its own, and is made only from Round trips and Linked wallets.
  It is wallets tied by evidence, not one person. See [methods.md](methods.md#rings).
- **Ring N.** A ring's rank by the ETH its flagged sales moved, Ring 1 the most. A new analysis can change it.
- **Anchor.** A ring's smallest wallet address, the `{anchor}` in its link (`/r/{anchor}`), so the link keeps
  opening the same wallets whatever its rank.

## Wallets and their roles

On a token, wallet, trade or ring page, **Connected to** lists the wallets with their role here.

- **Seller, buyer.** The two sides of a sale. A transfer that was no sale reads **sent it** and **got it**.
- **Funder.** A wallet that paid one of the wallets here, and is not one of them.
- **Payee.** A wallet one of the wallets here paid, and is not one of them.
- **In between.** A middle wallet (above).

## Reading money

- **Money read.** How many traders' payments have been read, and how many wallets out the worker follows.
- **Wallets out.** Hops of money followed out of a trader (`follow.hops`, "Follow money (wallets out)"), so a
  payment can return through wallets that never traded the collection.
- **Wallets between.** The wallets on a loop between seller and buyer, a setting of your own lenses.
- **Reach.** The wallets a collection's money has been walked to. The console says "Finding the wallets up to N
  wallets out".
- **Read again.** Reading a trader's money and other tokens a second time after it trades again (`follow.reread`,
  off by default; see [operating.md](operating.md#reading-traders-again)).
- **Other tokens.** Payments in a fixed list of tokens (USDC, USDT, DAI and APE on Ethereum; USDC and DAI on Base;
  none elsewhere), with no smallest amount: washtrace has no prices.
- **Payees' tokens.** Reading the tokens of the wallets a trader paid in those tokens too, off by default
  (`tokens.payees`).

## In a token's graph

- **Custody.** A contract holding a token without owning it, such as a Blur Blend loan. A → escrow → B is one hop
  A → B; A → escrow → A is none.
- **Bridge.** The paper's fix for missing transfers: an unobserved edge from a token's last holder to the next
  sender. Never flagged or counted; the console does not name it.

## Checking one transaction

- **Spot check.** Judging one transaction without watching its collection: its receipt, its tokens' histories and
  the money of the wallets in it. It never runs Money loops back. See
  [console.md](console.md#checking-a-transaction-you-do-not-watch).
