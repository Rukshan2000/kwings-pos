-- Lets the shop pick a color per category, so the till's category strip and
-- product accent bands use the shop's own colors instead of a fixed palette.
ALTER TABLE category ADD COLUMN color text;
