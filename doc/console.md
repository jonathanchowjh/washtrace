# The console

For people reading verdicts in the console: what each page shows and how to write a lens of your own. The words
it uses are in the [glossary](glossary.md). The console runs on port 8080 (see the README's
[Quick start](../README.md#quick-start)); everything it shows is also in the [API](api.md).

## Reading a collection page

A collection's pages lead with **the answer**: the share of its sales that looks washed, as a range from Round
trips (the floor) to Linked wallets (the ceiling). The first tab, **Overview**, puts these under it: how sure each
end is, with Money loops back set apart as not counted; a strip of every sale in order, each coloured by the
strongest lens that caught it; the tokens and wallets most flagged ETH went through; and what looks suspicious but
is not counted. Every figure opens the trades it counts. The reading itself is four marks, Stored data, Chain,
Money and Analysis; the six stages behind them are on the Methods tab and the Worker page.

Every page of a collection sits under one line naming it and a tab bar: Overview, Methods, Rings, Tokens, Wallets
and Trades. A ring lights Rings; a token lights Tokens, the list it belongs to; a wallet Wallets, a transaction
Trades. Tokens and Wallets count the lists of the lens in view (Linked wallets unless another is chosen), and say
"not run" for a lens that has not run. A lens chosen on one tab is kept on the others, and the lenses are always
in the same order: Round trips, Linked wallets, then Money loops back.

A token, wallet or trade page under a collection says what it is the same way (a ring's page is in the table below, in its own order):

- Under its title are its kind, a verdict chip naming the lens tier behind it (Round trips, the floor; Linked
  wallets, the ceiling; Money loops back, not counted) and the rings it is part of.
- Its answer ends in one line on how complete the evidence is: whether the money behind it has been read, and
  which analysis it comes from, such as "Money read for both wallets · analysis 07:26". A ring too big to list
  in full counts the wallets it lists. When the money is not all read, the line says so and why.
- Below the answer is the strip of every sale of the collection, with its own sales outlined (its first 2,000 at
  most, which its key then says).
- Then a **Connected to** panel in one order. It shows what the page is part of (the collection and its washed
  share, a trade's token), the wallets here with their role (seller, buyer, funder, payee, in between), and the
  transactions that tie them, by block. A ring's page lists none of the last two: its wallets and transactions
  are on the page itself.

A token, wallet, ring or trade opened from a collection's list carries `?from=`, the list it came from, and the
lens. A line above its title leads back to that list, says where the item sits in it, and steps to the item before
and after, across pages too (‹ ›, or K and J). The item is found in the list by what it is, so after a new analysis
reorders the list, one no longer on its page shows no steps. A lens of yours that was deleted falls back to
Linked wallets.

Resting the pointer on (or tabbing to) a wallet, token or ring link inside a collection shows a small card: its
trades here and how many are flagged, its ring, or a ring's size. Clicking still opens the page.

Times are clock times in the reader's time zone, changeable at the foot of the sidebar. "Overview" means the first
tab; "collection page" means the whole set.

## Pages

| Route | Content | Refresh |
|---|---|---|
| `/` | Watched collections in tabs, In sync, Paused and All, each with a count; the page opens on the tab you last chose. Each collection shows the share of its sales and volume that looks washed (Round trips to Linked wallets) and how complete the reading is. Find and sort, and a form to watch another. | 15 s |
| `/c/{chain}/{address}` | One collection at a glance, as [above](#reading-a-collection-page), and your lenses. | 15 s |
| `/c/{chain}/{address}/methods` | What the overview stands on: a tab per lens with its tokens and wallets, writing your own, each lens's share over time, and the six stages of the reading. Old `?method=` links to the overview come here. | 15 s |
| `/c/{chain}/{address}/rings` | Every [ring](methods.md#rings), the most ETH first, 20 a page: its wallets, tokens, flagged sales and ETH, and its **Pattern** (loops and linked pairs), under a key to the marks. Each opens what it counts. | On open |
| `/c/{chain}/{address}/r/{anchor}` | One ring, named by its smallest wallet. It reads top to bottom: a **story line** of what happened, with a time word only where the blocks prove it; **What happened**, a diagram of its sales and the payments Linked wallets used, with arrows numbered in time order, beside **In order** (below it on a phone), the list of those sales and payments with their amounts. A row of the list lights its arrow; its "tx ›" opens the transaction. Then **Who is in it**, one table of its wallets (traders first, then those in between, joined by money only); **Its tokens**, each with its own short story; the strip of every sale; and **Part of**. A ring of more than 25 wallets is listed, not drawn. A link to a ring that a new analysis renamed shows the ring or rings that wallet is in now, linked, or says it is in none. | On open |
| `/c/{chain}/{address}/tokens`, `/wallets` | Every token or wallet one lens flags, most flagged first. `?method=AU&page=2`. The old `/flagged?kind=` links redirect here. | On open |
| `/c/{chain}/{address}/trades` | The collection's trades, filtered by lens, market, price, date, wallet, token and ring, with a CSV download. Each row has a mark per lens and a short **Why**, and the whole row opens the trade. | On open |
| `/c/{chain}/{address}/t/{tokenId}` | One token: its verdict; **What it looks like**, its graph (as in the paper's Figure 8) with Money loops back drawing its loop; **Why it was flagged**, **Why it was not flagged** when it was judged and no lens caught it, or **Why Money loops back flags it** when only that lens does; and **Every transfer**. | On open |
| `/w/{chain}/{address}` | One wallet: how many of its trades are flagged, whether its money has been read, and who it moved money with. | On open |
| `/c/{chain}/{address}/w/{wallet}`, `/tx/{hash}` | A wallet or a transaction opened from a collection: the same page under its tabs, with the wallet's trades and counts in that collection alone. A payment a lens cited opens here too ([below](#reading-a-transaction-or-a-payment)). Links from a collection's pages open these. | On open |
| `/tx/{chain}/{hash}` | One transaction's verdict, and [Check this transaction](#checking-a-transaction-you-do-not-watch) where washtrace has not read or judged it. For a payment it stored, it shows "A payment washtrace read as money". | On open |
| `/search?q=` | A collection name, token number (`#1234`), wallet address or transaction hash, or the start of an address or hash (at least 4 hex characters after `0x`). A query too short to search says how long it must be. The sidebar search goes to the one thing it finds (via `/go`), else here. A hash nothing watched matches links to its transaction page on each chain the worker has an RPC for. Under a collection the box searches that collection (its tokens, the wallets that traded it, and the wallets that link a ring there: its funders, payees and in-between wallets), said in its placeholder and on a chip that drops the scope; `/` focuses it, and its list leads with the kind typed. A wallet that is the best match there has its rings and most-traded tokens listed under it. | On open |
| `/lab` | Your lenses side by side: each rule as a picture and in words, and every watched collection it runs on, with its share, what data it still needs there, and a tick to run it on more (Run on N). Each row has its own Preview, started only by its button, since previews run one at a time on the worker. Writing and editing a lens stay on a collection's Methods page, where its data is; the editor's *Also run it on* ticks other collections, and its button becomes Save and run on N. | On open |
| `/settings` | The settings in [operating.md](operating.md#settings), where each value came from, and a Test for the RPC and Etherscan. | On open |
| `/worker` | The answer ("Nothing has failed." or what needs you, with what to do), the four jobs, the sources, every collection's stages, and the controls: Pause, Resume, Prioritize and delete data. What to do when something is wrong is in [operating.md](operating.md#watching-it-run). | 5 s |

## Reading a transaction or a payment

A transaction's page gives its verdict, then a card for each lens that judged each token it moved, in the order
Round trips, Linked wallets, Money loops back. A card says why that lens caught the transfer or not. Where it used
payments as evidence, it lists them: the first four, then "and N more". On a phone the lens cards come right after
the verdict.

A payment a lens cited opens a page of its own, under the collection's tabs at `/c/{chain}/{address}/tx/{hash}`.
It shows who paid whom, how much, in which block and when, then, as it is found, **What it is evidence of**: which
lens used it, to flag which sales, and the wallets it connects. A payment that no built-in lens used in the latest
analysis says so, and that washtrace read it as money. A hash that is a sale of the collection stays a sale's
page. A sale is never shown as a payment.

Diagrams draw only the payments a lens used as evidence, and label an arrow with its amount. One legend names the
marks everywhere.

## Your own lenses

A lens of yours sits beside the three methods on a collection's page; **Copy to new lens** starts from one of
them. The editor sets which edges may carry the way back to the seller (NFT transfers, ETH, internal ETH, WETH
including Blur Pool, Other tokens), the wallets between seller and buyer, a time window, and which trades it
judges (sales, or every change of owner). **Advanced** shows the rest: each edge's direction, limit, smallest
payment and repeat rule, where the loop closes, the order in time, how many loops a trade needs, and wallets a
loop never passes through.

**Data this lens needs** says which reads the rule is short of, money that many wallets out or Other tokens; a
button asks the worker for them, and the share reads "so far" meanwhile. **Preview** tries the unsaved rule on a
sample of 2,000 sales (`PREVIEW_SAMPLE`) and compares its catch with Round trips. **Save and run** queues the
lens's run. The lens routes are in [api.md](api.md).

## Checking a transaction you do not watch

Where a transaction's page says washtrace has not read it, or has not judged it yet, a **Check this transaction**
panel sits under the answer. It asks the worker for a spot check: the transaction's receipt, each of its tokens'
histories, and the money of its sellers and buyers, without watching the collection.

- **Judge with** is **Built-in methods** (Round trips and Linked wallets) by default, or one of your lenses. A lens
  a spot check cannot run, one using Other tokens or the collection's other tokens, is shown greyed out with why.
- The answer arrives in seconds, polled every second: which lens flagged it, each flagged token with why and links
  to the wallets involved, and what could not run. Money loops back never runs on a spot check.
- "At least" means some wallets could not be judged, so the answer is not clean. "This block is not final yet"
  means the answer may change.
- A check that fails says why (an unknown transaction, an ERC-1155 transfer, a chain with no RPC) and has **Try
  again**.
- Where this console may not be written to, the button is greyed out, as Save is.

What a spot check can and cannot say is in [methods.md](methods.md#a-spot-check), and its routes in
[api.md](api.md#spot-checks).
