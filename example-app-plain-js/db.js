let _messages = [];
let _data = {
  todos: [],
  todoTypes: [],
  todoTypeMapping: [],
};

function insert(table, row) {
  // This is roughly comparable to assigning a primary key value to the row if it were in a RDBMS.
  let id = uuidv4();

  // Note that we're going to generate a "change" message for every field in the object that is being "inserted"
  let fields = Object.keys(row);

  const oplogMessages = fields.map((k) => {
    return {
      dataset: table,
      row: row.id || id,
      column: k,
      value: row[k],
      // Timestamp.send() returns a new, "next" time each time it's called, and since each time is unique, this means
      // that every message gets its own, globally-unique timestamp. In other words: there is a 1-1 relationship
      // between each message and its HLC timestamp.
      timestamp: Timestamp.send(getClock()).toString(),
    };
  });

  sendMessages(oplogMessages);

  return id;
}

function update(table, params) {
  let fields = Object.keys(params).filter((k) => k !== 'id');

  sendMessages(
    fields.map((k) => {
      return {
        dataset: table,
        row: params.id,
        column: k,
        value: params[k],
        timestamp: Timestamp.send(getClock()).toString(),
      };
    })
  );
}

function delete_(table, id) {
  sendMessages([
    {
      dataset: table,
      row: id,
      column: 'tombstone',
      value: 1,
      timestamp: Timestamp.send(getClock()).toString(),
    },
  ]);
}

function _resolveTodos(todos) {
  todos = todos.map((todo) => ({
    ...todo,
    type: todo.type ? getTodoType(todo.type) : null,
  }));

  todos.sort((t1, t2) => {
    if (t1.order < t2.order) {
      return 1;
    } else if (t1.order > t2.order) {
      return -1;
    }
    return 0;
  });

  return todos;
}

function getTodos() {
  return _resolveTodos(_data.todos.filter((todo) => todo.tombstone !== 1));
}

function getDeletedTodos() {
  return _resolveTodos(_data.todos.filter((todo) => todo.tombstone === 1));
}

function getAllTodos() {
  return _resolveTodos(_data.todos);
}

function getTodoType(id) {
  // Go through the mapping table, which is a layer of indirection. In
  // SQL you could think of doing a LEFT JOIN onto this table and
  // using the id from the mapping table instead of the raw id
  let mapping = _data.todoTypeMapping.find((m) => m.id === id);
  let type = mapping && _data.todoTypes.find((type) => type.id === mapping.targetId);
  return type && type.tombstone !== 1 ? type : null;
}

function getNumTodos() {
  return _data.todos.length;
}

function getTodoTypes() {
  return _data.todoTypes.filter((todoType) => todoType.tombstone !== 1);
}

function insertTodoType({ name, color }) {
  let id = insert('todoTypes', { name, color });

  // Create an entry in the mapping table that points it to itself
  insert('todoTypeMapping', { id, targetId: id });
}

function deleteTodoType(id, targetId) {
  if (targetId) {
    // We need to update all the pointers the point to the type that
    // we are deleting and point it to the new type. This already
    // includes the type we are deleting (when created, it creates a
    // mapping to itself)
    for (let mapping of _data.todoTypeMapping) {
      if (mapping.targetId === id) {
        update('todoTypeMapping', { id: mapping.id, targetId });
      }
    }
  }

  delete_('todoTypes', id);
}
