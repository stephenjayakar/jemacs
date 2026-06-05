def hello : String := "world"

theorem add_comm' (a b : Nat) : a + b = b + a := by
  induction a with
  | zero => simp
  | succ n ih => simp [Nat.succ_add, ih]

def double (n : Nat) : Nat := n + n

example : double 3 = 6 := by rfl
