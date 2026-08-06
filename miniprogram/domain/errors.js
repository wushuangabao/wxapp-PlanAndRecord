class DomainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
  }
}

class StorageError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.details = details;
  }
}

module.exports = {
  DomainError,
  StorageError
};
