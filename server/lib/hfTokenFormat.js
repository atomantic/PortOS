// The token format shared by Hugging Face credentials validation and settings.


// HF tokens are `hf_` + ~36 alphanumeric chars. Exported as a Zod-friendly
// regex so route schemas validate at the boundary instead of post-parse.
export const HF_TOKEN_REGEX = /^hf_[A-Za-z0-9_-]+$/;
