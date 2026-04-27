'use strict'

const fn = (count) => {
  console.log(`Привет ${count}`);
  if (count > 0) {
    fn(count - 1);
  };
  return;
};

fn(3)