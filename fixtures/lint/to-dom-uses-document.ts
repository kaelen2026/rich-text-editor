const invalidSpec = {
  toDOM: () => ["p", document.createElement("span")],
};

void invalidSpec;
