export interface Clock {
  now(): number;
}

export interface IdGenerator {
  nextId(): string;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

export const randomIdGenerator: IdGenerator = {
  nextId: () => Math.random().toString(36).slice(2, 8),
};
