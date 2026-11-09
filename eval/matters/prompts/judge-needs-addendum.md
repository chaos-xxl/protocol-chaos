ADDITIONAL CONTEXT FOR THIS EVALUATION

The memories here are the user's matters (plans, trips, purchases, appointments, goals), kept by the user's personal assistant, in Chinese. Each memory line is one matter: its title in 【】, its state (刚提起 just raised, 进行中 active, 等待中 waiting, 搁置 set aside, 已完成 done, 已取消 cancelled), its parent matter (上级), and its current goal (目标), constraint (条件), plan (安排) and progress (进展). The query and the response are in Chinese.

You are also given:
- gold_facts: the facts a good response must use for this query, as they stand now;
- stale_values: values that no longer hold (the user changed them later, or they belong to a plan that was cancelled or finished).

Apply the rating scale above, with these rules:
- Rate 3 only if the response uses every gold fact correctly. A fact may be used implicitly, for example by recommending only the options that satisfy it.
- A response that relies on a stale value draws the wrong conclusion: rate it at most 2, and 1 if the stale value drives the answer. Relying on a value means using it as if it held now. Mentioning an earlier value as history (for example, "the budget went from X to Y") is not relying on it.
- A constraint set on a parent matter also holds for its parts.
- The memories hold every matter of the user's store. A detail that comes from one of them is not invented, even when it is not among the gold facts; whether using it was appropriate is not part of this rating.
- Say separately whether the response relied on any stale value.

OUTPUT FORMAT (this replaces the format above)

Return only a single, valid JSON object:

{
  "rating": "[An integer from 1 to 3]",
  "stale": "[true if the response relied on any stale value, otherwise false]",
  "reasoning": "A brief explanation, naming the gold facts used or missed and any stale value relied on."
}
