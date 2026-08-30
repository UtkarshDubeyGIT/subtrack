update public.subscriptions
set
  payment_label = case
    when payment_label is not null
      and private.contains_payment_card_number(payment_label)
    then null
    else payment_label
  end,
  notes = case
    when notes is not null
      and private.contains_payment_card_number(notes)
    then null
    else notes
  end
where (
  payment_label is not null
  and private.contains_payment_card_number(payment_label)
) or (
  notes is not null
  and private.contains_payment_card_number(notes)
);

alter table public.subscriptions
  drop constraint subscriptions_payment_label_pan_free,
  drop constraint subscriptions_notes_pan_free;

alter table public.subscriptions
  add constraint subscriptions_payment_label_pan_free check (
    payment_label is null
    or not private.contains_payment_card_number(payment_label)
  ) not valid,
  add constraint subscriptions_notes_pan_free check (
    notes is null
    or not private.contains_payment_card_number(notes)
  ) not valid;

alter table public.subscriptions
  validate constraint subscriptions_payment_label_pan_free;

alter table public.subscriptions
  validate constraint subscriptions_notes_pan_free;
